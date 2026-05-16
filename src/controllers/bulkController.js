// ============================================================================
// Bulk Controller — Handles bulk CSV upload, processing, downloads, reports
// ============================================================================

const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const XLSX = require("xlsx");
const { v4: uuidv4 } = require("uuid");

const { parseFile } = require("../utils/csvParser");
const { validateBatch, validateColumns } = require("../utils/validator");
const blockchainService = require("../services/blockchainService");
const ipfsService = require("../services/ipfsService");
const pdfService = require("../services/pdfService");
const qrService = require("../services/qrService");
const emailService = require("../services/emailService");
const Certificate = require("../models/Certificate");
const { isServerlessRuntime } = require("../utils/runtimePaths");

// ── In-memory job store (use Redis/DB in production) ────────────────────────
const jobs = new Map();

// ── Upload & Validate CSV ───────────────────────────────────────────────────
// POST /api/bulk/upload
// Accepts a CSV/XLSX file, parses it, validates all rows, returns preview

async function uploadCSV(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;

    // Parse CSV/Excel
    const records = await parseFile(filePath);

    // Check required columns exist
    const colCheck = validateColumns(records);
    if (!colCheck.valid) {
      // Clean up uploaded file
      fs.unlinkSync(filePath);
      return res.status(400).json({
        error: "Missing required columns",
        missing: colCheck.missing,
        hint: colCheck.hint,
      });
    }

    // Validate all records
    const validation = validateBatch(records);

    // Create a job ID for this upload
    const jobId = uuidv4();

    // Store job data
    jobs.set(jobId, {
      id: jobId,
      status: "validated",
      filePath,
      fileName: req.file.originalname,
      records: validation.validRecords,
      invalidRecords: validation.invalidRecords,
      validation,
      createdAt: new Date().toISOString(),
      progress: null,
      results: null,
    });

    res.json({
      jobId,
      fileName: req.file.originalname,
      totalRows: validation.totalRows,
      validCount: validation.validCount,
      invalidCount: validation.invalidCount,
      hasErrors: validation.hasErrors,
      errors: validation.errors.slice(0, 50), // Cap at 50 errors in response
      warnings: validation.warnings.slice(0, 50),
      preview: validation.validRecords.slice(0, 10), // First 10 valid rows
      invalidPreview: validation.invalidRecords.slice(0, 10),
    });
  } catch (err) {
    console.error("Upload CSV error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ── Process Batch ───────────────────────────────────────────────────────────
// POST /api/bulk/process
// Body: { jobId, templateName?, sendEmails? }
// Issues certificates on blockchain, generates PDFs, QR codes, optionally sends emails

async function processBatch(req, res) {
  try {
    const { jobId, templateName = "default-certificate", sendEmails = false } = req.body;
    const walletAddress = req.walletAddress || null;

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required" });
    }

    const job = jobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (job.status === "processing") {
      return res.status(409).json({ error: "Job is already being processed" });
    }
    if (job.records.length === 0) {
      return res.status(400).json({ error: "No valid records to process" });
    }

    await blockchainService.assertBackendIssuerReady(walletAddress);
    pdfService.loadTemplate(templateName, walletAddress);

    // Mark as processing
    job.status = "processing";
    job.walletAddress = walletAddress;
    job.progress = {
      phase: "starting",
      current: 0,
      total: job.records.length,
      percent: 0,
    };

    if (isServerlessRuntime()) {
      await processPipeline(job, templateName, sendEmails, walletAddress);
      return res.json({
        jobId,
        status: job.status,
        totalRecords: job.records.length,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        progress: job.progress,
        summary: job.summary,
        results: job.results,
        message: "Processing completed in-request for serverless runtime.",
      });
    }

    // Respond immediately — processing continues in background
    res.json({
      jobId,
      status: "processing",
      totalRecords: job.records.length,
      message: "Processing started. Poll /api/bulk/status/:jobId for progress.",
    });

    // ── Run the pipeline in background ────────────────────────────────────
    processPipeline(job, templateName, sendEmails, walletAddress).catch((err) => {
      console.error(`Job ${jobId} pipeline error:`, err);
      job.status = "failed";
      job.error = err.message;
    });
  } catch (err) {
    console.error("Process batch error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ── The Processing Pipeline ─────────────────────────────────────────────────

async function processPipeline(job, templateName, sendEmails, walletAddress = null) {
  const certs = job.records;
  const results = [];

  // PHASE 1: Generate certificate IDs
  job.progress = { phase: "generating_ids", current: 0, total: certs.length, percent: 0 };

  for (let i = 0; i < certs.length; i++) {
    if (!certs[i].certId) {
      certs[i].certId = await blockchainService.generateCertificateId();
    }
  }

  // PHASE 2: Generate PDFs (keep in memory, don't upload yet)
  job.progress = { phase: "generating_pdfs", current: 0, total: certs.length, percent: 0 };

  const pdfResults = await pdfService.bulkGeneratePDFs(templateName, certs, (p) => {
    job.progress = { phase: "generating_pdfs", ...p };
  }, walletAddress);

  // PHASE 3: Upload to IPFS FIRST (before blockchain issuance)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Smart contract requires ipfsHash to be non-empty, so we must upload PDFs to IPFS
  // before attempting blockchain issuance
  job.progress = { phase: "uploading_ipfs", current: 0, total: certs.length, percent: 0 };

  let ipfsUploadCount = 0;
  for (let i = 0; i < certs.length; i++) {
    const cert = certs[i];
    const pdfResult = pdfResults[i];

    if (pdfResult?.status === "success" && pdfResult.buffer) {
      try {
        const documentHash = ipfsService.computeContentHash(pdfResult.buffer);
        cert.documentHash = documentHash;
        const ipfsResult = await ipfsService.uploadBuffer(
          pdfResult.buffer,
          pdfResult.fileName,
          { certId: cert.certId, type: "certificate", documentHash }
        );
        cert.ipfsHash = ipfsResult.ipfsHash;
        cert.ipfsPinned = ipfsResult.pinned;
        cert.ipfsGateway = ipfsResult.gateway;
        
        console.log(`✅ IPFS uploaded: ${cert.certId} → ${ipfsResult.ipfsHash}`);
        ipfsUploadCount++;
      } catch (err) {
        // IPFS upload failed — mark certificate for failure
        cert.ipfsHash = null;
        cert.ipfsError = err.message;
        console.error(`❌ IPFS upload failed for cert ${cert.certId}:`, err.message);
      }
    } else if (pdfResult?.status !== "success") {
      cert.ipfsHash = null;
      cert.ipfsError = "PDF generation failed";
    }

    job.progress = {
      phase: "uploading_ipfs",
      current: i + 1,
      total: certs.length,
      percent: Math.round(((i + 1) / certs.length) * 100),
    };
  }

  // PHASE 4: Issue on blockchain (with ipfsHash now available)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Now blockchain issuance will have ipfsHash ready
  job.progress = { phase: "blockchain_issuance", current: 0, total: certs.length, percent: 0 };

  // Filter out certificates that failed IPFS upload (no ipfsHash means blockchain will fail anyway)
  const certsReadyForBlockchain = certs.filter(c => c.ipfsHash);
  const certsFailed = certs.filter(c => !c.ipfsHash);

  let blockchainResults;
  try {
    blockchainResults = await blockchainService.issueBatch(certsReadyForBlockchain, (p) => {
      job.progress = { phase: "blockchain_issuance", ...p };
    });
  } catch (err) {
    // Handle critical blockchain service errors (e.g., rate limits, network issues)
    console.error("Critical blockchain service error:", err.message);
    
    // Log diagnostic info for rate limiting
    if (err.message.includes("rate") || err.message.includes("rate limit")) {
      console.error("🚨 RATE LIMIT DETECTED - Consider:");
      console.error("   1. Upgrading Alchemy plan");
      console.error("   2. Reducing batch size (max 50 certs per batch)");
      console.error("   3. Retrying in 30 seconds");
    }
    
    if (err.message.includes("Invalid JSON") || err.message.includes("UNSUPPORTED_OPERATION")) {
      console.error("🚨 RPC PROVIDER RETURNED INVALID JSON - May indicate:");
      console.error("   1. RPC provider service issue");
      console.error("   2. Rate limiting (too many requests per second)");
      console.error("   3. Network configuration issue");
    }
    
    // Treat all as failed if service is down
    const failedResults = certsReadyForBlockchain.map((c, i) => ({
      index: i,
      certId: c.certId,
      status: "failed",
      error: err.message || "Blockchain service unavailable",
    }));
    blockchainResults = { results: failedResults, succeeded: 0, failed: certsReadyForBlockchain.length, total: certsReadyForBlockchain.length };
  }

  // PHASE 5: Save blockchain results to database
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  job.progress = { phase: "saving_database", current: 0, total: certs.length, percent: 0 };

  for (let i = 0; i < blockchainResults.results.length; i++) {
    const bcResult = blockchainResults.results[i];
    const cert = certsReadyForBlockchain[i];

    if (bcResult.status === "success") {
      try {
        await Certificate.create({
          certId: cert.certId,
          studentName: cert.studentName,
          studentId: cert.studentId || null,
          degree: cert.degree,
          institution: cert.institution,
          issueDate: new Date(cert.issueDate),
          studentWallet: walletAddress || null,
          blockchain: {
            txHash: bcResult.txHash,
            blockNumber: bcResult.blockNumber,
            gasUsed: bcResult.gasUsed,
            issuedAt: new Date(),
          },
          ipfs: {
            documentHash: cert.documentHash || null,
            ipfsHash: cert.ipfsHash || null,
            pinned: cert.ipfsPinned || false,
            gateway: cert.ipfsGateway || null,
          },
          qr: {
            saved: false,
            filePath: null,
          },
          email: {
            sent: false,
            sentAt: null,
            error: null,
          },
        });
        console.log(`✅ Bulk cert ${cert.certId} saved to database with block number ${bcResult.blockNumber}`);
      } catch (dbErr) {
        console.error(`❌ CRITICAL: Failed to save bulk cert ${cert.certId} to database:`, dbErr.message);
      }
    }

    job.progress = {
      phase: "saving_database",
      current: i + 1,
      total: blockchainResults.results.length,
      percent: Math.round(((i + 1) / blockchainResults.results.length) * 100),
    };
  }

  // Track IPFS-failed certs separately
  for (const cert of certsFailed) {
    blockchainResults.results.push({
      index: certs.indexOf(cert),
      certId: cert.certId,
      status: "failed",
      error: `IPFS upload failed: ${cert.ipfsError}`,
    });
    blockchainResults.failed++;
  }

  // PHASE 5: Generate QR codes (only for successful blockchain certs)
  job.progress = { phase: "generating_qrcodes", current: 0, total: blockchainResults.succeeded, percent: 0 };

  const successfulCerts = certs.filter((c, i) => blockchainResults.results[i]?.status === "success");
  const qrResults = await qrService.bulkGenerateQR(successfulCerts);

  // PHASE 6: Send emails (if enabled and blockchain succeeded)
  let emailResults = null;
  if (sendEmails && emailService.isEmailConfigured()) {
    job.progress = { phase: "sending_emails", current: 0, total: successfulCerts.filter((c) => c.email).length, percent: 0 };

    const emailJobs = successfulCerts
      .filter((c) => c.email)
      .map((c) => ({
        to: c.email,
        studentName: c.studentName,
        certId: c.certId,
        degree: c.degree,
        institution: c.institution,
        issueDate: c.issueDate,
        pdfBuffer: pdfResults.find((p) => p.certId === c.certId)?.buffer,
        pdfFileName: pdfResults.find((p) => p.certId === c.certId)?.fileName,
      }));

    emailResults = await emailService.bulkSendEmails(emailJobs, (p) => {
      job.progress = { phase: "sending_emails", ...p };
    });
  }

  // ── Compile final results ───────────────────────────────────────────────
  for (let i = 0; i < certs.length; i++) {
    const cert = certs[i];
    const bcResult = blockchainResults.results[i];
    const pdfResult = pdfResults[i];
    const qrResult = qrResults.find((q) => q.certId === cert.certId);

    results.push({
      row: cert._row,
      certId: cert.certId,
      studentName: cert.studentName,
      studentId: cert.studentId,
      degree: cert.degree,
      institution: cert.institution,
      issueDate: cert.issueDate,
      email: cert.email || null,
      blockchain: {
        status: bcResult?.status || "skipped",
        txHash: bcResult?.txHash || null,
        blockNumber: bcResult?.blockNumber || null,
        gasUsed: bcResult?.gasUsed || null,
        error: bcResult?.error || null,
      },
      pdf: {
        status: pdfResult?.status || "skipped",
        fileName: pdfResult?.fileName || null,
        filePath: pdfResult?.filePath || null,
      },
      ipfs: {
        hash: cert.ipfsHash || null,
        documentHash: cert.documentHash || null,
        pinned: cert.ipfsPinned || false,
        gateway: cert.ipfsGateway || null,
        error: cert.ipfsError || null,
      },
      qr: {
        status: qrResult?.status || "skipped",
        fileName: qrResult?.fileName || null,
      },
    });
  }

  // Update job
  job.status = "completed";
  job.results = results;
  job.completedAt = new Date().toISOString();
  job.summary = {
    total: certs.length,
    blockchainSuccess: blockchainResults.succeeded,
    blockchainFailed: blockchainResults.failed,
    pdfsGenerated: pdfResults.filter((p) => p.status === "success").length,
    qrCodesGenerated: qrResults.filter((q) => q.status === "success").length,
    emailsSent: emailResults?.sent || 0,
    emailsFailed: emailResults?.failed || 0,
  };
  job.progress = { phase: "completed", current: certs.length, total: certs.length, percent: 100 };

  // Clean up uploaded CSV
  try {
    if (job.filePath && fs.existsSync(job.filePath)) {
      fs.unlinkSync(job.filePath);
    }
  } catch { /* ignore cleanup errors */ }

  console.log(`✅ Job ${job.id} completed:`, job.summary);
}

// ── Get Job Status ──────────────────────────────────────────────────────────
// GET /api/bulk/status/:jobId

async function getJobStatus(req, res) {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  const response = {
    jobId: job.id,
    status: job.status,
    fileName: job.fileName,
    totalRecords: job.records.length,
    createdAt: job.createdAt,
    progress: job.progress,
  };

  if (job.status === "completed") {
    response.completedAt = job.completedAt;
    response.summary = job.summary;
    response.results = job.results;
  }

  if (job.status === "failed") {
    response.error = job.error;
  }

  res.json(response);
}

// ── Download Batch as ZIP ───────────────────────────────────────────────────
// GET /api/bulk/download/:jobId

async function downloadBatch(req, res) {
  try {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (job.status !== "completed") {
      return res.status(400).json({ error: "Job is not yet completed" });
    }

    const zipFileName = `edulocka-batch-${jobId.slice(0, 8)}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    // Add PDFs
    const certDir = path.join(__dirname, "..", "..", "output", "certificates");
    const qrDir = path.join(__dirname, "..", "..", "output", "qrcodes");

    for (const result of job.results) {
      // Add certificate PDF
      if (result.pdf.filePath && fs.existsSync(result.pdf.filePath)) {
        archive.file(result.pdf.filePath, { name: `certificates/${result.pdf.fileName}` });
      }

      // Add QR code
      if (result.qr.fileName) {
        const qrPath = path.join(qrDir, result.qr.fileName);
        if (fs.existsSync(qrPath)) {
          archive.file(qrPath, { name: `qrcodes/${result.qr.fileName}` });
        }
      }
    }

    // Add a summary JSON
    archive.append(JSON.stringify(job.results, null, 2), { name: "summary.json" });

    await archive.finalize();
  } catch (err) {
    console.error("Download batch error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

// ── Generate Excel Report ───────────────────────────────────────────────────
// GET /api/reports/:jobId

async function generateReport(req, res) {
  try {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (job.status !== "completed") {
      return res.status(400).json({ error: "Job not completed yet" });
    }

    // Build report data
    const reportData = job.results.map((r) => ({
      "Row": r.row,
      "Certificate ID": r.certId,
      "Student Name": r.studentName,
      "Student ID": r.studentId,
      "Degree": r.degree,
      "Institution": r.institution,
      "Issue Date": r.issueDate,
      "Email": r.email || "",
      "Blockchain Status": r.blockchain.status,
      "TX Hash": r.blockchain.txHash || "",
      "Block Number": r.blockchain.blockNumber || "",
      "Gas Used": r.blockchain.gasUsed || "",
      "IPFS Hash": r.ipfs.hash || "",
      "IPFS Pinned": r.ipfs.pinned ? "Yes" : "No",
      "PDF Generated": r.pdf.status === "success" ? "Yes" : "No",
      "QR Generated": r.qr.status === "success" ? "Yes" : "No",
      "Verify URL": qrService.getVerifyUrl(r.certId),
    }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(reportData);

    // Auto-width columns
    const colWidths = Object.keys(reportData[0] || {}).map((key) => ({
      wch: Math.max(key.length, 20),
    }));
    worksheet["!cols"] = colWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, "Certificates");

    // Summary sheet
    const summaryData = [
      { Metric: "Total Certificates", Value: job.summary.total },
      { Metric: "Blockchain Success", Value: job.summary.blockchainSuccess },
      { Metric: "Blockchain Failed", Value: job.summary.blockchainFailed },
      { Metric: "PDFs Generated", Value: job.summary.pdfsGenerated },
      { Metric: "QR Codes Generated", Value: job.summary.qrCodesGenerated },
      { Metric: "Emails Sent", Value: job.summary.emailsSent },
      { Metric: "Emails Failed", Value: job.summary.emailsFailed },
      { Metric: "Job Created", Value: job.createdAt },
      { Metric: "Job Completed", Value: job.completedAt },
    ];
    const summarySheet = XLSX.utils.json_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

    // Write to buffer
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const fileName = `edulocka-report-${jobId.slice(0, 8)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (err) {
    console.error("Generate report error:", err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  uploadCSV,
  processBatch,
  getJobStatus,
  downloadBatch,
  generateReport,
};
