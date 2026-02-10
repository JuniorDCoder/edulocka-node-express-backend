// ============================================================================
// PDF Service — Generate certificate PDFs from HTML templates
// ============================================================================
// Uses Puppeteer to render HTML templates into pixel-perfect PDFs
// Supports custom HTML templates with Handlebars placeholders

const puppeteer = require("puppeteer");
const Handlebars = require("handlebars");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const qrService = require("./qrService");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "templates");
const INSTITUTION_TEMPLATES_DIR = path.join(TEMPLATES_DIR, "institutions");
const OUTPUT_DIR = path.join(__dirname, "..", "..", "output", "certificates");

// Ensure institution templates directory exists
if (!fs.existsSync(INSTITUTION_TEMPLATES_DIR)) {
  fs.mkdirSync(INSTITUTION_TEMPLATES_DIR, { recursive: true });
}

// ── Register Handlebars helpers ─────────────────────────────────────────────

Handlebars.registerHelper("formatDate", function (timestamp) {
  if (!timestamp) return "";
  const date =
    typeof timestamp === "number"
      ? new Date(timestamp * 1000)
      : new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
});

Handlebars.registerHelper("currentYear", function () {
  return new Date().getFullYear();
});

Handlebars.registerHelper("uppercase", function (str) {
  return str ? str.toUpperCase() : "";
});

// ── Load template ───────────────────────────────────────────────────────────
// Looks in institution-specific directory first, then falls back to global

function loadTemplate(templateName = "default-certificate", walletAddress = null) {
  // If wallet provided, check institution-specific directory first
  if (walletAddress) {
    const institutionDir = path.join(INSTITUTION_TEMPLATES_DIR, walletAddress.toLowerCase());
    const institutionPath = path.join(institutionDir, `${templateName}.html`);
    if (fs.existsSync(institutionPath)) {
      return fs.readFileSync(institutionPath, "utf8");
    }
  }

  // Fall back to global templates directory (for default templates)
  const templatePath = path.join(TEMPLATES_DIR, `${templateName}.html`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templateName}`);
  }
  return fs.readFileSync(templatePath, "utf8");
}

// ── Render HTML from template + data ────────────────────────────────────────

async function renderHTML(templateName, data, walletAddress = null) {
  const templateSource = loadTemplate(templateName, walletAddress);
  const template = Handlebars.compile(templateSource);

  // Generate QR code data URL for embedding
  const qrDataUrl = await qrService.generateQRDataURL(data.certId, {
    width: 150,
  });

  const verifyUrl = qrService.getVerifyUrl(data.certId);

  const html = template({
    ...data,
    qrDataUrl,
    verifyUrl,
    generatedAt: new Date().toISOString(),
    currentYear: new Date().getFullYear(),
  });

  return html;
}

// ── Generate PDF from HTML ──────────────────────────────────────────────────

async function generatePDF(templateName, data, options = {}, walletAddress = null) {
  const html = await renderHTML(templateName, data, walletAddress);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });

    const pdfBuffer = await page.pdf({
      format: options.format || "A4",
      landscape: options.landscape || true,
      printBackground: true,
      margin: {
        top: options.marginTop || "0",
        right: options.marginRight || "0",
        bottom: options.marginBottom || "0",
        left: options.marginLeft || "0",
      },
    });

    return Buffer.from(pdfBuffer);
  } finally {
    if (browser) await browser.close();
  }
}

// ── Save PDF to disk ────────────────────────────────────────────────────────

async function savePDF(templateName, data, options = {}, walletAddress = null) {
  const pdfBuffer = await generatePDF(templateName, data, options, walletAddress);

  const sanitizedName = data.studentName.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, "_");
  const fileName =
    options.fileName || `${data.certId}-${sanitizedName}.pdf`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  fs.writeFileSync(filePath, pdfBuffer);

  return {
    filePath,
    fileName,
    size: pdfBuffer.length,
    buffer: pdfBuffer,
  };
}

// ── Bulk PDF generation ─────────────────────────────────────────────────────
// Uses a single browser instance for efficiency

async function bulkGeneratePDFs(templateName, certificates, onProgress, walletAddress = null) {
  const results = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    for (let i = 0; i < certificates.length; i++) {
      const cert = certificates[i];
      try {
        const html = await renderHTML(templateName, cert, walletAddress);
        const page = await browser.newPage();

        await page.setContent(html, {
          waitUntil: "networkidle0",
          timeout: 30000,
        });

        const pdfBuffer = await page.pdf({
          format: "A4",
          landscape: true,
          printBackground: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });

        await page.close();

        const sanitizedName = cert.studentName
          .replace(/[^a-zA-Z0-9\s]/g, "")
          .replace(/\s+/g, "_");
        const fileName = `${cert.certId}-${sanitizedName}.pdf`;
        const filePath = path.join(OUTPUT_DIR, fileName);

        fs.writeFileSync(filePath, pdfBuffer);

        results.push({
          certId: cert.certId,
          filePath,
          fileName,
          size: pdfBuffer.length,
          buffer: Buffer.from(pdfBuffer),
          status: "success",
        });
      } catch (err) {
        results.push({
          certId: cert.certId,
          status: "failed",
          error: err.message,
        });
      }

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: certificates.length,
          percent: Math.round(((i + 1) / certificates.length) * 100),
        });
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  return results;
}

// ── List available templates (scoped per institution) ────────────────────────
// Returns default templates + institution-specific templates if walletAddress provided

function listTemplates(walletAddress = null) {
  const templates = [];

  // 1) Always include global/default templates (exclude email templates & institutions dir)
  if (fs.existsSync(TEMPLATES_DIR)) {
    const globalTemplates = fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".html") && !f.includes("email"))
      .map((f) => {
        const name = f.replace(".html", "");
        return {
          id: name,
          name: name
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" "),
          path: path.join(TEMPLATES_DIR, f),
          owner: "default",
        };
      });
    templates.push(...globalTemplates);
  }

  // 2) If a wallet address is provided, add institution-specific templates
  if (walletAddress) {
    const institutionDir = path.join(INSTITUTION_TEMPLATES_DIR, walletAddress.toLowerCase());
    if (fs.existsSync(institutionDir)) {
      const instTemplates = fs
        .readdirSync(institutionDir)
        .filter((f) => f.endsWith(".html"))
        .map((f) => {
          const name = f.replace(".html", "");
          return {
            id: name,
            name: name
              .split("-")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" "),
            path: path.join(institutionDir, f),
            owner: walletAddress.toLowerCase(),
          };
        });
      templates.push(...instTemplates);
    }
  }

  return templates;
}

// ── Get the institution templates directory for a wallet ─────────────────────

function getInstitutionTemplateDir(walletAddress) {
  const dir = path.join(INSTITUTION_TEMPLATES_DIR, walletAddress.toLowerCase());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

module.exports = {
  loadTemplate,
  renderHTML,
  generatePDF,
  savePDF,
  bulkGeneratePDFs,
  listTemplates,
  getInstitutionTemplateDir,
};
