// ============================================================================
// Certificate Controller — Single issuance, verification, templates, QR, email
// ============================================================================

const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const crypto = require("crypto");

const blockchainService = require("../services/blockchainService");
const ipfsService = require("../services/ipfsService");
const pdfService = require("../services/pdfService");
const qrService = require("../services/qrService");
const emailService = require("../services/emailService");
const aiTemplateService = require("../services/aiTemplateService");
const templateStoreService = require("../services/templateStoreService");
const { validateCertificate } = require("../utils/validator");
const { isServerlessRuntime } = require("../utils/runtimePaths");
const Certificate = require("../models/Certificate");

// On serverless runtimes the function may be frozen/terminated immediately
// after the response is sent, killing any un-awaited background work. Await
// email delivery there; on long-lived servers, fire-and-forget as before.
// Either way, failures are logged and never affect the caller's response.
async function deliverEmail(promise, label) {
  if (isServerlessRuntime()) {
    try {
      await promise;
    } catch (err) {
      console.error(`${label} failed (non-blocking):`, err);
    }
  } else {
    promise.catch((err) => {
      console.error(`${label} failed (non-blocking):`, err);
    });
  }
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sanitizeTemplateId(value) {
  const baseName = String(value || "ai-certificate-template")
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return baseName || "ai-certificate-template";
}

function getUniqueTemplatePath(dir, requestedName) {
  let templateId = sanitizeTemplateId(requestedName);
  let destPath = path.join(dir, `${templateId}.html`);
  let index = 2;

  while (fs.existsSync(destPath)) {
    templateId = `${sanitizeTemplateId(requestedName)}-${index}`;
    destPath = path.join(dir, `${templateId}.html`);
    index += 1;
  }

  return { templateId, destPath };
}

function mergeTemplateLists(fileTemplates, storedTemplates, walletAddress) {
  const seen = new Set(fileTemplates.map((template) => `${template.owner}:${template.id}`));
  const wallet = templateStoreService.normalizeWalletAddress(walletAddress);
  const storedOnly = storedTemplates
    .filter((template) => !seen.has(`${wallet}:${template.templateId}`))
    .map((template) => ({
      id: template.templateId,
      name: template.name || templateStoreService.displayNameFromTemplateId(template.templateId),
      path: templateStoreService.getTemplatePath(wallet, template.templateId),
      owner: wallet,
    }));

  return [...fileTemplates, ...storedOnly];
}

function getOwnedTemplatePath(walletAddress, templateId) {
  if (!walletAddress) {
    throw new Error("Wallet authentication required");
  }

  const safeTemplateId = sanitizeTemplateId(templateId);
  if (safeTemplateId !== String(templateId || "").toLowerCase()) {
    throw new Error("Invalid template ID");
  }

  const institutionDir = pdfService.getInstitutionTemplateDir(walletAddress);
  return {
    templateId: safeTemplateId,
    templatePath: path.join(institutionDir, `${safeTemplateId}.html`),
  };
}

async function assertAuthorizedTemplateOwner(walletAddress) {
  const isAuthorized = await blockchainService.checkIfAuthorized(walletAddress);
  if (!isAuthorized) {
    const err = new Error("Only authorized institutions can manage certificate templates.");
    err.statusCode = 403;
    throw err;
  }
}

function sampleTemplateData(institutionName) {
  return {
    certId: "CERT-2026-TPL-001",
    studentName: "Jane Doe",
    studentId: "STU-2026-001",
    degree: "Bachelor of Science in Computer Science",
    institution: institutionName || "Edulocka University",
    issueDate: "2026-06-15",
  };
}

async function fetchBufferWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const bytes = await res.arrayBuffer();
    return Buffer.from(bytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchIpfsDocument(ipfsHash) {
  const candidates = [
    ipfsService.getGatewayUrl(ipfsHash),
    `https://ipfs.io/ipfs/${ipfsHash}`,
    `https://cloudflare-ipfs.com/ipfs/${ipfsHash}`,
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  const errors = [];
  for (const url of candidates) {
    try {
      const buffer = await fetchBufferWithTimeout(url);
      return { buffer, url };
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }

  throw new Error(`Unable to fetch IPFS document from gateways. ${errors.join(" | ")}`);
}

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
      documentMode = req.file ? "upload" : "template",
    } = req.body;
    const walletAddress = req.walletAddress || null;

    await blockchainService.assertBackendIssuerReady(walletAddress);

    // Validate
    const cert = { studentName, studentId, degree, institution, issueDate, email };
    const validation = validateCertificate(cert);
    if (!validation.valid) {
      return res.status(400).json({ error: "Validation failed", errors: validation.errors });
    }

    if (documentMode === "upload" && (!req.file || !req.file.buffer)) {
      return res.status(400).json({ error: "Please upload a PDF certificate document, or switch back to template mode." });
    }

    // Generate cert ID
    const certId = await blockchainService.generateCertificateId();

    let pdfResult;
    let documentHash;
    let ipfsResult;

    if (documentMode === "upload" && req.file?.buffer) {
      const sanitizedName = studentName.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "_");
      const uploadedFileName = `${certId}-${sanitizedName}.pdf`;
      pdfResult = {
        fileName: uploadedFileName,
        filePath: null,
        size: req.file.buffer.length,
        buffer: req.file.buffer,
      };
      documentHash = ipfsService.computeContentHash(req.file.buffer);
    } else {
      await templateStoreService.restoreInstitutionTemplate(walletAddress, templateName);
      // Generate PDF from selected template
      pdfResult = await pdfService.savePDF(
        templateName,
        {
          ...cert,
          certId,
        },
        {},
        walletAddress
      );
      documentHash = ipfsService.computeContentHash(pdfResult.buffer);
    }

    // Upload to IPFS (to get hash for blockchain)
    try {
      ipfsResult = await ipfsService.uploadBuffer(
        pdfResult.buffer,
        pdfResult.fileName,
        { certId, type: "certificate", documentHash }
      );
    } catch (ipfsErr) {
      console.error("IPFS upload failed:", ipfsErr);
      return res.status(500).json({ 
        error: "Failed to upload certificate to IPFS. The blockchain network may be temporarily unavailable. Please try again.",
        details: ipfsErr.message 
      });
    }

    // Issue on blockchain (with IPFS hash)
    let txResult;
    try {
      txResult = await blockchainService.issueCertificate({
        certId,
        studentName,
        studentId,
        degree,
        institution,
        issueDate,
        ipfsHash: ipfsResult.ipfsHash,
      });
    } catch (bcErr) {
      console.error("Blockchain issuance failed:", bcErr);
      // Provide specific error message based on error type
      let errorMsg = "Failed to record certificate on blockchain.";
      if (bcErr.code === "UNSUPPORTED_OPERATION" || String(bcErr.message).includes("Invalid JSON")) {
        errorMsg = "Blockchain network is temporarily unavailable or rate limited. Please try again in a moment.";
      } else if (String(bcErr.message).includes("rate limit")) {
        errorMsg = "Blockchain provider rate limit exceeded. Please retry after a few seconds.";
      } else if (String(bcErr.message).includes("insufficient funds")) {
        errorMsg = "Insufficient gas in issuer wallet. Contact your administrator.";
      }
      return res.status(500).json({ 
        error: errorMsg,
        details: bcErr.message 
      });
    }

    // Save QR code
    const qrResult = await qrService.saveQRToFile(certId, { width: 600 });
    const qrDataUrl = await qrService.generateQRDataURL(certId);

    // Save certificate metadata to database
    try {
      await Certificate.create({
        certId,
        studentName,
        studentId,
        studentEmail: email || null,
        degree,
        institution,
        issueDate: new Date(issueDate),
        studentWallet: walletAddress,
        blockchain: {
          txHash: txResult.txHash,
          blockNumber: txResult.blockNumber,
          gasUsed: txResult.gasUsed,
          issuedAt: new Date(),
        },
        ipfs: {
          documentHash,
          ipfsHash: ipfsResult.ipfsHash,
          pinned: ipfsResult.pinned,
          gateway: ipfsResult.gateway,
        },
        qr: {
          saved: qrResult !== null,
          filePath: qrResult?.filePath || null,
        },
        email: {
          sent: email && emailService.isEmailConfigured() ? true : false,
          sentAt: null,
          error: null,
        },
      });
      console.log(`✅ Certificate ${certId} saved to database with block number ${txResult.blockNumber}`);
    } catch (dbErr) {
      console.error(`❌ CRITICAL: Failed to save certificate ${certId} to database:`, dbErr.message);
      // We should NOT ignore this error anymore to ensure DB consistency
      // However, the cert is already on blockchain. 
      // We'll return a partial success message but still res.json success
      // Or better, we should probably have retried or failed earlier.
      // For now, let's at least log it as ERROR and not WARN.
    }

    // Send email if requested and configured
    if (email && emailService.isEmailConfigured()) {
      await deliverEmail(
        emailService.sendCertificateEmail({
          to: email,
          studentName,
          studentId,
          certId,
          degree,
          institution,
          issueDate,
          pdfBuffer: pdfResult.buffer,
          pdfFileName: pdfResult.fileName,
        }),
        "Certificate email send"
      );
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
        documentHash,
        pinned: ipfsResult.pinned,
        gateway: ipfsResult.gateway,
      },
      pdf: {
        fileName: pdfResult.fileName,
        url: `/api/certificates/${certId}/pdf`,
      },
      qr: {
        fileName: qrResult.fileName,
        url: `/output/qrcodes/${qrResult.fileName}`,
        dataUrl: qrDataUrl,
      },
      verifyUrl: qrService.getVerifyUrl(certId),
      message: email && emailService.isEmailConfigured() ? "Certificate issued and email will be sent shortly." : "Certificate issued successfully."
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
    // First, try to get from database (preferred)
    const dbCert = await Certificate.findOne({ certId });
    if (dbCert) {
      return res.json({
        exists: true,
        isValid: dbCert.status === "issued",
        studentName: dbCert.studentName,
        studentId: dbCert.studentId,
        degree: dbCert.degree,
        institution: dbCert.institution,
        issueDate: Math.floor(new Date(dbCert.issueDate).getTime() / 1000),
        ipfsHash: dbCert.ipfs?.ipfsHash || "",
        issuer: dbCert.studentWallet, // In our schema, studentWallet is used for the institution/issuer address if not specified otherwise
        status: dbCert.status,
        verifyUrl: qrService.getVerifyUrl(certId),
        qrDataUrl: await qrService.generateQRDataURL(certId),
        fromDatabase: true
      });
    }

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
// VERIFY UPLOADED CERTIFICATE DOCUMENT
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/certificates/verify-file
// multipart/form-data: { certId?, document }

async function verifyCertificateDocument(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "document file is required" });
    }

    const requestedCertId = String(req.body.certId || "").trim();
    const uploadedBuffer = req.file.buffer;
    const uploadedSha256 = sha256Hex(uploadedBuffer);
    let certId = requestedCertId;
    let matchedDbCert = null;
    let verificationMode = "certId";

    if (!certId) {
      matchedDbCert = await Certificate.findOne({ "ipfs.documentHash": uploadedSha256 });
      if (!matchedDbCert) {
        return res.status(404).json({
          exists: false,
          lookup: "documentHash",
          uploaded: {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: uploadedBuffer.length,
            sha256: uploadedSha256,
          },
          message:
            "No Edulocka certificate record has an IPFS document hash matching this uploaded PDF.",
        });
      }

      certId = matchedDbCert.certId;
      verificationMode = "documentHash";
    }

    const certificate = await blockchainService.verifyCertificate(certId);
    if (!certificate.exists) {
      return res.status(404).json({
        exists: false,
        certId,
        lookup: verificationMode,
        uploaded: {
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: uploadedBuffer.length,
          sha256: uploadedSha256,
        },
        message: `Certificate \"${certId}\" not found on blockchain`,
      });
    }

    if (!certificate.ipfsHash) {
      return res.status(409).json({
        exists: true,
        certId,
        lookup: verificationMode,
        uploaded: {
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: uploadedBuffer.length,
          sha256: uploadedSha256,
        },
        error: "Certificate has no on-chain IPFS hash to compare against",
      });
    }

    let ipfsDoc;
    try {
      ipfsDoc = await fetchIpfsDocument(certificate.ipfsHash);
    } catch (err) {
      return res.status(502).json({
        exists: true,
        certId,
        lookup: verificationMode,
        uploaded: {
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: uploadedBuffer.length,
          sha256: uploadedSha256,
        },
        ipfs: {
          hash: certificate.ipfsHash,
        },
        error: err.message,
      });
    }

    const ipfsSha256 = sha256Hex(ipfsDoc.buffer);
    const hashMatch = uploadedSha256 === ipfsSha256;
    const exactBytesMatch =
      hashMatch &&
      uploadedBuffer.length === ipfsDoc.buffer.length &&
      uploadedBuffer.equals(ipfsDoc.buffer);

    res.json({
      exists: true,
      certId,
      lookup: verificationMode,
      certificate: {
        isValid: certificate.isValid,
        studentName: certificate.studentName,
        degree: certificate.degree,
        institution: certificate.institution,
        issueDate: certificate.issueDate,
        issuer: certificate.issuer,
        ipfsHash: certificate.ipfsHash,
      },
      uploaded: {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: uploadedBuffer.length,
        sha256: uploadedSha256,
      },
      ipfs: {
        hash: certificate.ipfsHash,
        gatewayUrl: ipfsDoc.url,
        size: ipfsDoc.buffer.length,
        sha256: ipfsSha256,
      },
      match: {
        sha256: hashMatch,
        exactBytes: exactBytesMatch,
      },
      verified: certificate.isValid && hashMatch,
      verifyUrl: qrService.getVerifyUrl(certId),
    });
  } catch (err) {
    console.error("Verify document error:", err);
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

    const existingPdfPath = pdfService.findExistingPdfPath(certId);
    if (existingPdfPath && fs.existsSync(existingPdfPath)) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${path.basename(existingPdfPath)}"`);
      return res.sendFile(existingPdfPath);
    }

    // Fetch certificate data from blockchain
    const cert = await blockchainService.verifyCertificate(certId);
    if (!cert.exists) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    if (cert.ipfsHash) {
      try {
        const ipfsDoc = await fetchIpfsDocument(cert.ipfsHash);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${certId}.pdf"`);
        res.setHeader("X-Edulocka-PDF-Source", "ipfs");
        return res.send(ipfsDoc.buffer);
      } catch (err) {
        console.warn(`Falling back to rendered PDF for ${certId}:`, err.message);
      }
    }

    const pdfBuffer = await pdfService.generatePDF(templateName, {
      certId,
      ...cert,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${certId}.pdf"`);
    res.setHeader("X-Edulocka-PDF-Source", "rendered");
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Generate PDF error:", err);
    const message = err instanceof Error ? err.message : "PDF generation failed";
    const missingBrowser =
      message.includes("Could not find Chrome") ||
      message.includes("Could not find Chromium") ||
      message.includes("PUPPETEER_EXECUTABLE_PATH");

    res.status(missingBrowser ? 503 : 500).json({ error: message });
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
    const baseName = sanitizeTemplateId(path.basename(req.file.originalname, ext));

    // Save to institution-specific directory
    const institutionDir = pdfService.getInstitutionTemplateDir(walletAddress);
    const destPath = path.join(institutionDir, `${baseName}.html`);

    // Move uploaded file to institution templates directory
    fs.renameSync(req.file.path, destPath);
    const html = fs.readFileSync(destPath, "utf8");
    await templateStoreService.upsertInstitutionTemplate({
      walletAddress,
      templateId: baseName,
      html,
      source: "upload",
    });

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
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

// POST /api/templates/generate-ai  (requires wallet auth + authorized institution)
async function generateTemplateWithAI(req, res) {
  try {
    const walletAddress = req.walletAddress;
    if (!walletAddress) {
      return res.status(401).json({ error: "Wallet authentication required to generate templates" });
    }

    const isAuthorized = await blockchainService.checkIfAuthorized(walletAddress);
    if (!isAuthorized) {
      return res.status(403).json({
        error: "Only authorized institutions can generate certificate templates with AI.",
      });
    }

    const {
      prompt,
      templateName,
      institutionName,
      tone,
      colorPalette,
    } = req.body || {};

    if (!prompt || String(prompt).trim().length < 12) {
      return res.status(400).json({ error: "Describe the certificate template you want in at least 12 characters." });
    }

    await templateStoreService.restoreInstitutionTemplates(walletAddress);
    const institutionDir = pdfService.getInstitutionTemplateDir(walletAddress);
    const { templateId, destPath } = getUniqueTemplatePath(institutionDir, templateName);

    const { html, placeholders } = await aiTemplateService.generateCertificateTemplate({
      prompt: String(prompt).trim(),
      institutionName: String(institutionName || "").trim(),
      tone: String(tone || "").trim(),
      colorPalette: String(colorPalette || "").trim(),
    });

    fs.writeFileSync(destPath, html, "utf8");
    await templateStoreService.upsertInstitutionTemplate({
      walletAddress,
      templateId,
      html,
      source: "ai",
      placeholders,
    });

    // The template is already saved at this point — a failed preview render
    // (e.g. cold-start Chromium issues on serverless) must not turn an
    // otherwise-successful save into an error response.
    let previewHtml = null;
    let previewWarning;
    try {
      previewHtml = await pdfService.renderHTML(
        templateId,
        {
          certId: "CERT-2026-AI-001",
          studentName: "Jane Doe",
          studentId: "STU-2026-001",
          degree: "Bachelor of Science in Computer Science",
          institution: institutionName || "Edulocka University",
          issueDate: "2026-06-15",
        },
        walletAddress
      );
    } catch (previewErr) {
      console.error("AI template preview render error:", previewErr);
      previewWarning = "Template saved, but the live preview could not be rendered right now.";
    }

    res.json({
      success: true,
      templateId,
      owner: walletAddress.toLowerCase(),
      message: `Template "${templateId}" generated and saved to your institution's templates.`,
      placeholders,
      previewHtml,
      ...(previewWarning && { previewWarning }),
    });
  } catch (err) {
    console.error("AI template generation error:", err);
    const status = err.statusCode || (err.message?.includes("Gemini is not configured") ? 503 : 500);
    res.status(status).json({ error: err.message || "Failed to generate template" });
  }
}

// PUT /api/templates/:templateId  (requires wallet auth + authorized institution)
async function saveTemplateHTML(req, res) {
  try {
    const walletAddress = req.walletAddress;
    await assertAuthorizedTemplateOwner(walletAddress);

    const { templateId } = req.params;
    const { html, institutionName } = req.body || {};

    if (!html || String(html).trim().length < 120) {
      return res.status(400).json({ error: "Template HTML must be at least 120 characters." });
    }

    const { templatePath } = getOwnedTemplatePath(walletAddress, templateId);
    fs.writeFileSync(templatePath, String(html), "utf8");
    await templateStoreService.upsertInstitutionTemplate({
      walletAddress,
      templateId,
      html: String(html),
      source: "builder",
    });

    // The template is already saved at this point — a failed preview render
    // must not turn an otherwise-successful save into an error response.
    let previewHtml = null;
    let previewWarning;
    try {
      previewHtml = await pdfService.renderHTML(templateId, sampleTemplateData(institutionName), walletAddress);
    } catch (previewErr) {
      console.error("Template preview render error:", previewErr);
      previewWarning = "Template saved, but the live preview could not be rendered right now.";
    }

    res.json({
      success: true,
      templateId,
      owner: walletAddress.toLowerCase(),
      message: `Template "${templateId}" saved to your institution's library.`,
      previewHtml,
      ...(previewWarning && { previewWarning }),
    });
  } catch (err) {
    console.error("Save template error:", err);
    res.status(err.statusCode || (err.message === "Invalid template ID" ? 400 : 500)).json({
      error: err.message || "Failed to save template",
    });
  }
}

// DELETE /api/templates/:templateId  (requires wallet auth + authorized institution)
async function deleteTemplate(req, res) {
  try {
    const walletAddress = req.walletAddress;
    await assertAuthorizedTemplateOwner(walletAddress);

    const { templateId } = req.params;
    const { templatePath } = getOwnedTemplatePath(walletAddress, templateId);
    await templateStoreService.restoreInstitutionTemplate(walletAddress, templateId);

    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: `Template "${templateId}" not found in your institution library.` });
    }

    fs.unlinkSync(templatePath);
    await templateStoreService.markInstitutionTemplateDeleted(walletAddress, templateId);

    res.json({
      success: true,
      templateId,
      owner: walletAddress.toLowerCase(),
      message: `Template "${templateId}" deleted from your institution's library.`,
    });
  } catch (err) {
    console.error("Delete template error:", err);
    res.status(err.statusCode || (err.message === "Invalid template ID" ? 400 : 500)).json({
      error: err.message || "Failed to delete template",
    });
  }
}

// POST /api/templates/:templateId/edit-ai  (requires wallet auth + authorized institution)
async function editTemplateWithAI(req, res) {
  try {
    const walletAddress = req.walletAddress;
    await assertAuthorizedTemplateOwner(walletAddress);

    const { templateId } = req.params;
    const { prompt, institutionName } = req.body || {};

    if (!prompt || String(prompt).trim().length < 12) {
      return res.status(400).json({ error: "Describe the edit you want in at least 12 characters." });
    }

    const { templatePath } = getOwnedTemplatePath(walletAddress, templateId);
    await templateStoreService.restoreInstitutionTemplate(walletAddress, templateId);
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: `Template "${templateId}" not found in your institution library.` });
    }

    const existingHtml = fs.readFileSync(templatePath, "utf8");
    const { html, placeholders } = await aiTemplateService.editCertificateTemplate({
      prompt: String(prompt).trim(),
      existingHtml,
    });

    fs.writeFileSync(templatePath, html, "utf8");
    await templateStoreService.upsertInstitutionTemplate({
      walletAddress,
      templateId,
      html,
      source: "ai_edit",
      placeholders,
    });

    // The template is already saved at this point — a failed preview render
    // must not turn an otherwise-successful save into an error response.
    let previewHtml = null;
    let previewWarning;
    try {
      previewHtml = await pdfService.renderHTML(templateId, sampleTemplateData(institutionName), walletAddress);
    } catch (previewErr) {
      console.error("AI template edit preview render error:", previewErr);
      previewWarning = "Template saved, but the live preview could not be rendered right now.";
    }

    res.json({
      success: true,
      templateId,
      owner: walletAddress.toLowerCase(),
      message: `Template "${templateId}" updated with AI.`,
      placeholders,
      previewHtml,
      ...(previewWarning && { previewWarning }),
    });
  } catch (err) {
    console.error("AI template edit error:", err);
    const status = err.message?.includes("Gemini is not configured")
      ? 503
      : err.statusCode || (err.message === "Invalid template ID" ? 400 : 500);
    res.status(status).json({ error: err.message || "Failed to edit template with AI" });
  }
}

// GET /api/templates  (optional wallet auth — unauthenticated gets defaults only)
async function listTemplates(req, res) {
  try {
    const walletAddress = req.walletAddress || null;
    const storedTemplates = walletAddress
      ? await templateStoreService.restoreInstitutionTemplates(walletAddress)
      : [];
    const templates = mergeTemplateLists(
      pdfService.listTemplates(walletAddress),
      storedTemplates,
      walletAddress
    );
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
    if (walletAddress) {
      await templateStoreService.restoreInstitutionTemplate(walletAddress, templateName);
    }

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

// GET /api/templates/:templateId
// Returns the HTML content of a template by ID
async function getTemplate(req, res) {
  try {
    const { templateId } = req.params;
    const walletAddress = req.walletAddress || null;

    if (!templateId) {
      return res.status(400).json({ error: "templateId is required" });
    }

    // Load template HTML from pdfService (handles both default and institution templates)
    if (walletAddress) {
      await templateStoreService.restoreInstitutionTemplate(walletAddress, templateId);
    }
    const html = await pdfService.loadTemplateHTML(templateId, walletAddress);

    if (!html) {
      return res.status(404).json({ error: `Template "${templateId}" not found` });
    }

    res.json({ html, templateId });
  } catch (err) {
    console.error("Get template error:", err);
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

// ─────────────────────────────────────────────────────────────────────────────
// GET CERTIFICATE DATA (from database with actual block number)
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/certificates/:certId/data
// Returns certificate metadata including the actual blockchain block number

async function getCertificateData(req, res) {
  try {
    const { certId } = req.params;

    // First, try to get from database (preferred - has actual block number)
    const dbCert = await Certificate.findOne({ certId });
    if (dbCert) {
      return res.json({
        certId: dbCert.certId,
        studentName: dbCert.studentName,
        studentId: dbCert.studentId,
        studentWallet: dbCert.studentWallet,
        degree: dbCert.degree,
        institution: dbCert.institution,
        issueDate: dbCert.issueDate,
        status: dbCert.status,
        blockchain: {
          txHash: dbCert.blockchain.txHash,
          blockNumber: dbCert.blockchain.blockNumber,
          gasUsed: dbCert.blockchain.gasUsed,
          issuedAt: dbCert.blockchain.issuedAt,
        },
        ipfs: dbCert.ipfs,
        qr: dbCert.qr,
        email: dbCert.email,
        createdAt: dbCert.createdAt,
      });
    }

    // Fallback: Query blockchain and reconstruct (won't have block number if event lookup fails)
    const cert = await blockchainService.verifyCertificate(certId);
    if (!cert.exists) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    // Attempt to get txHash from events as a last resort
    let fallbackTxHash = "unknown";
    let fallbackBlockNumber = 0;
    try {
      const provider = blockchainService.getProvider();
      const contract = blockchainService.getReadContract();
      const filter = contract.filters.CertificateIssued(certId);
      const currentBlock = await provider.getBlockNumber();
      const events = await contract.queryFilter(filter, currentBlock - 5000, currentBlock);
      if (events.length > 0) {
        fallbackTxHash = events[0].transactionHash;
        fallbackBlockNumber = events[0].blockNumber;
      }
    } catch (e) {
      console.warn(`Fallback event lookup failed for ${certId}:`, e.message);
    }

    res.json({
      certId,
      studentName: cert.studentName,
      studentWallet: cert.issuer,
      degree: cert.degree,
      institution: cert.institution,
      issueDate: new Date(Number(cert.issueDate) * 1000).toISOString().split("T")[0],
      status: cert.isValid ? "issued" : "revoked",
      ipfsHash: cert.ipfsHash,
      blockchain: {
        txHash: fallbackTxHash,
        blockNumber: fallbackBlockNumber, // May still be 0 if fallback fails
        gasUsed: 0,
      },
      warning: fallbackBlockNumber > 0 
        ? "Certificate data retrieved from blockchain. Database record missing."
        : "Certificate data retrieved from blockchain only; block number may be incomplete. Please re-issue or verify with backend admin.",
    });
  } catch (err) {
    console.error("Get certificate data error:", err);
    res.status(500).json({ error: err.message });
  }
}

async function listCertificates(req, res) {
  try {
    const { wallet, txHash } = req.query;
    const query = {};

    if (wallet) {
      query.studentWallet = { $regex: new RegExp(`^${wallet}$`, "i") };
    }

    if (txHash) {
      query["blockchain.txHash"] = { $regex: new RegExp(`^${txHash}$`, "i") };
    }

    if (Object.keys(query).length === 0) {
      return res.status(400).json({ error: "wallet or txHash query parameter is required" });
    }

    const certificates = await Certificate.find(query).sort({ createdAt: -1 }).limit(100);
    res.json(certificates);
  } catch (err) {
    console.error("List certificates error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REVOKE CERTIFICATE
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/certificates/:certId/revoke

async function revokeSingle(req, res) {
  try {
    const { certId } = req.params;
    const walletAddress = req.walletAddress;

    const isAuthorized = await blockchainService.checkIfAuthorized(walletAddress);
    if (!isAuthorized) {
      return res.status(403).json({ error: "Only authorized institutions can revoke certificates" });
    }

    const cert = await Certificate.findOne({ certId });
    if (!cert) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    if (cert.status === "revoked") {
      return res.status(409).json({ error: "Certificate is already revoked" });
    }

    const result = await blockchainService.revokeCertificate(certId);

    const revokedAt = new Date();
    await Certificate.updateOne(
      { certId },
      {
        status: "revoked",
        revokedAt,
        revokedBy: walletAddress,
        revokedTxHash: result.txHash,
        revokedBlockNumber: result.blockNumber,
      }
    );

    // Notify the student by email (never fails the revocation)
    if (cert.studentEmail) {
      await deliverEmail(
        emailService.sendCertificateRevokedEmail({
          to: cert.studentEmail,
          studentName: cert.studentName,
          studentId: cert.studentId,
          certId,
          degree: cert.degree,
          institution: cert.institution,
          revokedAt,
        }),
        "Revocation email send"
      );
    }

    res.json({
      success: true,
      certId,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      message: "Certificate revoked successfully",
    });
  } catch (err) {
    console.error("Revoke single error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK REVOKE CERTIFICATES
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/certificates/bulk-revoke

async function bulkRevoke(req, res) {
  try {
    const { certIds } = req.body;
    const walletAddress = req.walletAddress;

    if (!certIds || !Array.isArray(certIds) || certIds.length === 0) {
      return res.status(400).json({ error: "certIds array is required" });
    }

    if (certIds.length > 50) {
      return res.status(400).json({ error: "Maximum 50 certificates per bulk revoke" });
    }

    const isAuthorized = await blockchainService.checkIfAuthorized(walletAddress);
    if (!isAuthorized) {
      return res.status(403).json({ error: "Only authorized institutions can revoke certificates" });
    }

    const results = [];
    for (const certId of certIds) {
      try {
        const cert = await Certificate.findOne({ certId });
        if (!cert) {
          results.push({ certId, success: false, error: "Not found" });
          continue;
        }
        if (cert.status === "revoked") {
          results.push({ certId, success: false, error: "Already revoked" });
          continue;
        }
        const txResult = await blockchainService.revokeCertificate(certId);
        const revokedAt = new Date();
        await Certificate.updateOne(
          { certId },
          {
            status: "revoked",
            revokedAt,
            revokedBy: walletAddress,
            revokedTxHash: txResult.txHash,
            revokedBlockNumber: txResult.blockNumber,
          }
        );

        // Notify the student by email (never fails the revocation)
        if (cert.studentEmail) {
          await deliverEmail(
            emailService.sendCertificateRevokedEmail({
              to: cert.studentEmail,
              studentName: cert.studentName,
              studentId: cert.studentId,
              certId,
              degree: cert.degree,
              institution: cert.institution,
              revokedAt,
            }),
            "Revocation email send"
          );
        }

        results.push({ certId, success: true, txHash: txResult.txHash });
      } catch (err) {
        results.push({ certId, success: false, error: err.message });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    res.json({ success: true, total: certIds.length, succeeded, failed, results });
  } catch (err) {
    console.error("Bulk revoke error:", err);
    res.status(500).json({ error: err.message });
  }
}

async function listRecentCertificates(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const certificates = await Certificate.find({})
      .sort({ createdAt: -1 })
      .limit(limit);
    
    res.json(certificates);
  } catch (err) {
    console.error("List recent certificates error:", err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  issueSingle,
  verifyCertificate,
  verifyCertificateDocument,
  generatePDF,
  uploadTemplate,
  generateTemplateWithAI,
  editTemplateWithAI,
  saveTemplateHTML,
  deleteTemplate,
  listTemplates,
  getTemplate,
  previewTemplate,
  getQRCode,
  bulkExportQR,
  sendEmail,
  bulkSendEmails,
  getCertificateData,
  listCertificates,
  listRecentCertificates,
  revokeSingle,
  bulkRevoke,
};
