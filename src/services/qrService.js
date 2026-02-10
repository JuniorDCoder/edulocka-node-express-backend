// ============================================================================
// QR Code Service — Generate verification QR codes
// ============================================================================
// Creates QR codes that link to the verification page
// Supports: individual PNG, labeled (with student name), bulk ZIP

const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL || "http://localhost:3000/verify";
const OUTPUT_DIR = path.join(__dirname, "..", "..", "output", "qrcodes");

// ── Generate verification URL ───────────────────────────────────────────────

function getVerifyUrl(certId) {
  return `${VERIFY_BASE_URL}?certId=${encodeURIComponent(certId)}`;
}

// ── Generate QR code as PNG buffer ──────────────────────────────────────────

async function generateQRBuffer(certId, options = {}) {
  const url = getVerifyUrl(certId);
  const qrOptions = {
    type: "png",
    width: options.width || 400,
    margin: options.margin || 2,
    color: {
      dark: options.darkColor || "#111827",
      light: options.lightColor || "#FFFFFF",
    },
    errorCorrectionLevel: options.errorCorrection || "M",
  };

  return QRCode.toBuffer(url, qrOptions);
}

// ── Generate QR code as data URL (for embedding in HTML/PDF) ────────────────

async function generateQRDataURL(certId, options = {}) {
  const url = getVerifyUrl(certId);
  return QRCode.toDataURL(url, {
    width: options.width || 200,
    margin: options.margin || 1,
    color: {
      dark: options.darkColor || "#111827",
      light: options.lightColor || "#FFFFFF",
    },
    errorCorrectionLevel: "M",
  });
}

// ── Generate QR code as SVG string ──────────────────────────────────────────

async function generateQRSVG(certId, options = {}) {
  const url = getVerifyUrl(certId);
  return QRCode.toString(url, {
    type: "svg",
    width: options.width || 200,
    margin: options.margin || 1,
    color: {
      dark: options.darkColor || "#111827",
      light: options.lightColor || "#FFFFFF",
    },
    errorCorrectionLevel: "M",
  });
}

// ── Save QR code to file ────────────────────────────────────────────────────

async function saveQRToFile(certId, options = {}) {
  const buffer = await generateQRBuffer(certId, {
    width: options.width || 600,
    ...options,
  });

  const fileName = options.fileName || `${certId}.png`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  fs.writeFileSync(filePath, buffer);
  return { filePath, fileName, size: buffer.length };
}

// ── Generate labeled QR (QR code + student name below) ──────────────────────
// Returns an HTML string that can be converted to image/PDF

function generateLabeledQRHTML(certId, studentName, options = {}) {
  const url = getVerifyUrl(certId);
  const width = options.width || 200;

  return `
    <div style="display:inline-block;text-align:center;padding:16px;border:1px solid #e5e7eb;border-radius:8px;margin:8px;font-family:system-ui,sans-serif;">
      <img src="{{qrDataUrl}}" width="${width}" height="${width}" alt="QR Code" style="display:block;margin:0 auto;" />
      <p style="margin:8px 0 2px;font-weight:600;font-size:14px;color:#111827;">${studentName}</p>
      <p style="margin:0;font-size:11px;color:#6b7280;font-family:monospace;">${certId}</p>
      <p style="margin:4px 0 0;font-size:10px;color:#9ca3af;">Scan to verify</p>
    </div>
  `;
}

// ── Bulk generate QR codes ──────────────────────────────────────────────────

async function bulkGenerateQR(certificates, options = {}) {
  const results = [];

  for (const cert of certificates) {
    try {
      const saved = await saveQRToFile(cert.certId, {
        width: options.width || 600,
        fileName: options.labeled
          ? `${cert.certId}-${cert.studentName.replace(/[^a-zA-Z0-9]/g, "_")}.png`
          : `${cert.certId}.png`,
      });
      results.push({ certId: cert.certId, ...saved, status: "success" });
    } catch (err) {
      results.push({
        certId: cert.certId,
        status: "failed",
        error: err.message,
      });
    }
  }

  return results;
}

module.exports = {
  getVerifyUrl,
  generateQRBuffer,
  generateQRDataURL,
  generateQRSVG,
  saveQRToFile,
  generateLabeledQRHTML,
  bulkGenerateQR,
};
