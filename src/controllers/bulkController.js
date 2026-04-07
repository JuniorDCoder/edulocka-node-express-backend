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

  // PHASE 3: Issue on blockchain FIRST (before IPFS upload)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Only upload to IPFS for certificates that succeed on blockchain
  job.progress = { phase: "blockchain_issuance", current: 0, total: certs.length, percent: 0 };

  let blockchainResults;
  try {
    blockchainResults = await blockchainService.issueBatch(certs, (p) => {
      job.progress = { phase: "blockchain_issuance", ...p };
    });
  } catch (err) {
    // Handle critical blockchain service errors (e.g., rate limits, network issues)
    console.error("Critical blockchain service error:", err.message);
    
    // Log diagnostic info for rate limiting
    if (err.message.includes("rate") || err.message.includes("rate limit")) {
      console.error("🚨 RATE LIMIT DETECTED - Consider:");
      console.error("   1. Upgrading Infura plan from free to paid");
      console.error("   2. Using a different RPC provider (Alchemy, QuickNode)");
      console.error("   3. Reducing batch size (max 50 certs per batch)");
    }
    
    if (err.message.includes("Invalid JSON") || err.message.includes("UNSUPPORTED_OPERATION")) {
      console.error("🚨 RPC PROVIDER RETURNED INVALID JSON - May indicate:");
      console.error("   1. Infura service temporarily down");
      console.error("   2. Rate limiting (too many requests per second)");
      console.error("   3. Network configuration issue");
    }
    
    // Treat all as failed if service is down
    const failedResults = certs.map((c, i) => ({
      index: i,
      certId: c.certId,
      status: "failed",
      error: err.message || "Blockchain service unavailable",
    }));
    blockchainResults = { results: failedResults, succeeded: 0, failed: certs.length, total: certs.length };
  }

  // PHASE 4: Upload to IPFS (only for successful blockchain certs)
  job.progress = { phase: "uploading_ipfs", current: 0, total: blockchainResults.succeeded, percent: 0 };

  let ipfsUploadCount = 0;
  for (let i = 0; i < blockchainResults.results.length; i++) {
    const bcResult = blockchainResults.results[i];
    const cert = certs[i];
    const pdfResult = pdfResults[i];

    // Only upload to IPFS if blockchain issuance succeeded
    if (bcResult.status === "success" && pdfResult?.status === "success" && pdfResult.buffer) {
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
        ipfsUploadCount++;
      } catch (err) {
        cert.ipfsHash = "";
        cert.ipfsError = err.message;
        console.error(`IPFS upload failed for cert ${cert.certId}:`, err.message);
      }
    } else if (bcResult.status !== "success") {
      // Blockchain failed — skip IPFS upload entirely
      cert.ipfsHash = "";
      cert.ipfsError = "Skipped (blockchain issuance failed)";
    }

    job.progress = {
      phase: "uploading_ipfs",
      current: ipfsUploadCount + 1,
      total: blockchainResults.succeeded || 1,
      percent: Math.round((ipfsUploadCount / (blockchainResults.succeeded || 1)) * 100),
    };
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
