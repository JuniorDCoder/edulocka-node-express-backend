// ============================================================================
// Certificate Controller — Single issuance, verification, templates, QR, email
// ============================================================================

const path = require("path");
const fs = require("fs");
const archiver = require("archiver");

const blockchainService = require("../services/blockchainService");
const ipfsService = require("../services/ipfsService");
const pdfService = require("../services/pdfService");
const qrService = require("../services/qrService");
const emailService = require("../services/emailService");
const { validateCertificate } = require("../utils/validator");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "templates");

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE CERTIFICATE ISSUANCE
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/certificates/issue
// Body: { studentName, studentId, degree, institution, issueDate, email?, templateName? }

async function issueSingle(req, res) {
  try {
    const {
      studentName,
      studentId,
      degree,
      institution,
      issueDate,
      email,
      templateName = "default-certificate",
    } = req.body;

    // Validate
    const cert = { studentName, studentId, degree, institution, issueDate, email };
    const validation = validateCertificate(cert);
    if (!validation.valid) {
      return res.status(400).json({ error: "Validation failed", errors: validation.errors });
    }

    // Generate cert ID
    const certId = await blockchainService.generateCertificateId();

    // Generate PDF + QR
    const pdfResult = await pdfService.savePDF(templateName, {
      ...cert,
      certId,
    });

    // Upload PDF to IPFS
    const ipfsResult = await ipfsService.uploadBuffer(
      pdfResult.buffer,
      pdfResult.fileName,
      { certId, type: "certificate" }
    );

    // Issue on blockchain
    const txResult = await blockchainService.issueCertificate({
      certId,
      studentName,
      studentId,
      degree,
      institution,
      issueDate,
      ipfsHash: ipfsResult.ipfsHash,
    });

    // Save QR code
    const qrResult = await qrService.saveQRToFile(certId, { width: 600 });
    const qrDataUrl = await qrService.generateQRDataURL(certId);

    // Send email if requested and configured
    let emailResult = null;
    if (email) {
      emailResult = await emailService.sendCertificateEmail({
        to: email,
        studentName,
        certId,
        degree,
        institution,
        issueDate,
        pdfBuffer: pdfResult.buffer,
        pdfFileName: pdfResult.fileName,
      });
    }

    res.json({
      success: true,
      certId,
      blockchain: {
        txHash: txResult.txHash,
        blockNumber: txResult.blockNumber,
        gasUsed: txResult.gasUsed,
      },
      ipfs: {
        hash: ipfsResult.ipfsHash,
        pinned: ipfsResult.pinned,
        gateway: ipfsResult.gateway,
      },
      pdf: {
        fileName: pdfResult.fileName,
        url: `/output/certificates/${pdfResult.fileName}`,
      },
      qr: {
        fileName: qrResult.fileName,
        url: `/output/qrcodes/${qrResult.fileName}`,
        dataUrl: qrDataUrl,
      },
      verifyUrl: qrService.getVerifyUrl(certId),
      email: emailResult,
    });
  } catch (err) {
    console.error("Issue single error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY CERTIFICATE
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/certificates/verify/:certId

async function verifyCertificate(req, res) {
  try {
    const { certId } = req.params;
    const result = await blockchainService.verifyCertificate(certId);

    if (!result.exists) {
      return res.status(404).json({
        exists: false,
        message: `Certificate "${certId}" not found on blockchain`,
      });
    }

    const qrDataUrl = await qrService.generateQRDataURL(certId);

    res.json({
      ...result,
      verifyUrl: qrService.getVerifyUrl(certId),
      qrDataUrl,
    });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE PDF FOR EXISTING CERTIFICATE
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/certificates/:certId/pdf?template=default-certificate

async function generatePDF(req, res) {
  try {
    const { certId } = req.params;
    const templateName = req.query.template || "default-certificate";

    // Fetch certificate data from blockchain
    const cert = await blockchainService.verifyCertificate(certId);
    if (!cert.exists) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    const pdfBuffer = await pdfService.generatePDF(templateName, {
      certId,
      ...cert,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${certId}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Generate PDF error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE MANAGEMENT (institution-scoped)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/templates/upload  (requires wallet auth)
async function uploadTemplate(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No template file uploaded" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== ".html" && ext !== ".htm") {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Only HTML template files are supported" });
    }

    // Get the authenticated wallet address
    const walletAddress = req.walletAddress;
    if (!walletAddress) {
      fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: "Wallet authentication required to upload templates" });
    }

    // Sanitize the template name
    const baseName = path
      .basename(req.file.originalname, ext)
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .toLowerCase();

    // Save to institution-specific directory
    const institutionDir = pdfService.getInstitutionTemplateDir(walletAddress);
    const destPath = path.join(institutionDir, `${baseName}.html`);

    // Move uploaded file to institution templates directory
    fs.renameSync(req.file.path, destPath);

    res.json({
      success: true,
      templateId: baseName,
      owner: walletAddress.toLowerCase(),
      message: `Template "${baseName}" uploaded to your institution's templates`,
      placeholders: [
        "{{studentName}}", "{{studentId}}", "{{degree}}",
        "{{institution}}", "{{issueDate}}", "{{certId}}",
        "{{qrDataUrl}}", "{{verifyUrl}}", "{{currentYear}}",
      ],
    });
  } catch (err) {
    console.error("Upload template error:", err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/templates  (optional wallet auth — unauthenticated gets defaults only)
async function listTemplates(req, res) {
  try {
    const walletAddress = req.walletAddress || null;
    const templates = pdfService.listTemplates(walletAddress);
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/templates/preview  (optional wallet auth for institution templates)
// Body: { templateName, sampleData? }
async function previewTemplate(req, res) {
  try {
    const { templateName = "default-certificate", sampleData } = req.body;
    const walletAddress = req.walletAddress || null;

    const data = sampleData || {
      certId: "CERT-2026-001-ABC",
      studentName: "Jane Doe",
      studentId: "STU-2026-001",
      degree: "Bachelor of Science in Computer Science",
      institution: "Massachusetts Institute of Technology",
      issueDate: "2026-06-15",
    };

    const html = await pdfService.renderHTML(templateName, data, walletAddress);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QR CODE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/qr/:certId?format=png&width=400
async function getQRCode(req, res) {
  try {
    const { certId } = req.params;
    const format = req.query.format || "png";
    const width = parseInt(req.query.width) || 400;

    if (format === "svg") {
      const svg = await qrService.generateQRSVG(certId, { width });
      res.setHeader("Content-Type", "image/svg+xml");
      return res.send(svg);
    }

    if (format === "dataurl") {
      const dataUrl = await qrService.generateQRDataURL(certId, { width });
      return res.json({ certId, dataUrl, verifyUrl: qrService.getVerifyUrl(certId) });
    }

    // Default: PNG
    const buffer = await qrService.generateQRBuffer(certId, { width });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${certId}-qr.png"`);
    res.send(buffer);
  } catch (err) {
    console.error("QR code error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/qr/bulk-export
// Body: { certIds: string[], labeled?: boolean, width?: number }
async function bulkExportQR(req, res) {
  try {
    const { certIds, labeled = false, width = 600 } = req.body;

    if (!certIds || !Array.isArray(certIds) || certIds.length === 0) {
      return res.status(400).json({ error: "certIds array is required" });
    }

    // Generate all QR codes
    const certificates = certIds.map((id) => ({ certId: id, studentName: id }));
    await qrService.bulkGenerateQR(certificates, { width, labeled });

    // ZIP them up
    const zipFileName = `qrcodes-${Date.now()}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    const qrDir = path.join(__dirname, "..", "..", "output", "qrcodes");
    for (const certId of certIds) {
      const fileName = `${certId}.png`;
      const filePath = path.join(qrDir, fileName);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: fileName });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("Bulk QR export error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/email/send
// Body: { to, certId, studentName, degree, institution, issueDate }
async function sendEmail(req, res) {
  try {
    const { to, certId, studentName, degree, institution, issueDate } = req.body;

    if (!to || !certId) {
      return res.status(400).json({ error: "to (email) and certId are required" });
    }

    // Try to find existing PDF
    const certDir = path.join(__dirname, "..", "..", "output", "certificates");
    let pdfBuffer = null;
    let pdfFileName = null;

    const files = fs.existsSync(certDir) ? fs.readdirSync(certDir) : [];
    const matching = files.find((f) => f.startsWith(certId));
    if (matching) {
      pdfBuffer = fs.readFileSync(path.join(certDir, matching));
      pdfFileName = matching;
    }

    const result = await emailService.sendCertificateEmail({
      to,
      studentName: studentName || certId,
      certId,
      degree: degree || "Certificate",
      institution: institution || "Edulocka",
      issueDate: issueDate || new Date().toISOString(),
      pdfBuffer,
      pdfFileName,
    });

    res.json(result);
  } catch (err) {
    console.error("Send email error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/email/bulk-send/:jobId
async function bulkSendEmails(req, res) {
  try {
    // For simplicity, this re-uses the bulk controller's job store
    // In production, you'd have a shared store
    res.status(501).json({
      error: "Use the bulk/process endpoint with sendEmails: true instead",
      hint: "POST /api/bulk/process { jobId, sendEmails: true }",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  issueSingle,
  verifyCertificate,
  generatePDF,
  uploadTemplate,
  listTemplates,
  previewTemplate,
  getQRCode,
  bulkExportQR,
  sendEmail,
  bulkSendEmails,
};
