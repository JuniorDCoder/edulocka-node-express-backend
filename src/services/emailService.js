// ============================================================================
// Email Service — Send certificate emails via SMTP (Nodemailer)
// ============================================================================
// Sends personalized emails with PDF attachments and verification links
// Supports: single send, bulk send, delivery tracking

const nodemailer = require("nodemailer");
const Handlebars = require("handlebars");
const fs = require("fs");
const path = require("path");
const qrService = require("./qrService");

const TEMPLATES_DIR = path.join(__dirname, "..", "..", "templates");

// ── Create SMTP transporter ────────────────────────────────────────────────

function getSmtpCredentials() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USERNAME || process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
  const encryption = String(process.env.SMTP_ENCRYPTION || "").toLowerCase();
  const secure = encryption === "ssl" ? true : encryption === "tls" ? false : port === 465;

  return { host, port, user, pass, secure };
}

function getFromAddress() {
  const address = process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USERNAME || process.env.SMTP_USER;
  const name = process.env.SMTP_FROM_NAME;
  if (name) return `"${name}" <${address}>`;
  return process.env.EMAIL_FROM || address;
}

function getFrontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
}

function getPortalUrl() {
  return `${getFrontendBaseUrl()}/student/login`;
}

function getExplorerTxUrl(txHash) {
  const base = (process.env.EXPLORER_BASE_URL || "https://sepolia.etherscan.io").replace(/\/+$/, "");
  return `${base}/tx/${txHash}`;
}

function createTransporter() {
  const { host, port, user, pass, secure } = getSmtpCredentials();

  if (!host || !user || !pass) {
    return null; // Email not configured
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

function isEmailConfigured() {
  const { host, user, pass } = getSmtpCredentials();
  return !!(host && user && pass);
}

// ── Load email template ─────────────────────────────────────────────────────

function loadEmailTemplate() {
  const templatePath = path.join(TEMPLATES_DIR, "email-template.html");
  if (!fs.existsSync(templatePath)) {
    // Fallback to a simple plain-text style
    return `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#111827;">🎓 Your Certificate is Ready!</h2>
        <p>Dear <strong>{{studentName}}</strong>,</p>
        <p>Congratulations! Your certificate for <strong>{{degree}}</strong> from
           <strong>{{institution}}</strong> has been issued and recorded on the blockchain.</p>
        <p><strong>Certificate ID:</strong> <code>{{certId}}</code></p>
        <p><strong>Issue Date:</strong> {{issueDate}}</p>
        <p>Your certificate is attached to this email as a PDF. You can verify it anytime at:</p>
        <p><a href="{{verifyUrl}}" style="color:#2563eb;">{{verifyUrl}}</a></p>
        <p>Best regards,<br/>{{institution}}</p>
      </div>
    `;
  }
  return fs.readFileSync(templatePath, "utf8");
}

// ── Send single certificate email ───────────────────────────────────────────

async function sendCertificateEmail({
  to,
  studentName,
  studentId,
  certId,
  degree,
  institution,
  issueDate,
  pdfBuffer,
  pdfFileName,
}) {
  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      error: "Email not configured. Set SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD in .env",
    };
  }

  // Render email body
  const templateSource = loadEmailTemplate();
  const template = Handlebars.compile(templateSource);

  const verifyUrl = qrService.getVerifyUrl(certId);
  const qrDataUrl = await qrService.generateQRDataURL(certId, { width: 150 });

  const formattedDate =
    typeof issueDate === "number"
      ? new Date(issueDate * 1000).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : issueDate;

  const html = template({
    studentName,
    studentId: studentId || null,
    certId,
    degree,
    institution,
    issueDate: formattedDate,
    verifyUrl,
    qrDataUrl,
    portalUrl: getPortalUrl(),
    currentYear: new Date().getFullYear(),
  });

  // Build attachments
  const attachments = [];

  if (pdfBuffer) {
    attachments.push({
      filename: pdfFileName || `${certId}-Certificate.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf",
    });
  }

  // Embed QR code as inline image
  const qrBuffer = await qrService.generateQRBuffer(certId, { width: 200 });
  attachments.push({
    filename: `${certId}-QR.png`,
    content: qrBuffer,
    cid: "qrcode",
    contentType: "image/png",
  });

  try {
    const info = await transporter.sendMail({
      from: getFromAddress(),
      to,
      subject: `🎓 Your ${degree} Certificate — ${institution}`,
      html,
      attachments,
    });

    return {
      sent: true,
      messageId: info.messageId,
      to,
    };
  } catch (err) {
    return {
      sent: false,
      to,
      error: err.message,
    };
  }
}

// ── Send revocation notice email ────────────────────────────────────────────

function loadRevocationTemplate() {
  const templatePath = path.join(TEMPLATES_DIR, "email-certificate-revoked.html");
  if (!fs.existsSync(templatePath)) {
    return `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#dc2626;">Certificate Revoked</h2>
        <p>Dear <strong>{{studentName}}</strong>,</p>
        <p>Your certificate <strong>{{certId}}</strong> ({{degree}}) issued by
           <strong>{{institution}}</strong> has been revoked and is no longer valid.</p>
        {{#if studentId}}<p><strong>Student ID:</strong> {{studentId}}</p>{{/if}}
        <p>If you believe this is a mistake, please contact {{institution}} directly.</p>
        <p>You can view all your certificates by logging into the student portal:</p>
        <p><a href="{{portalUrl}}" style="color:#2563eb;">{{portalUrl}}</a></p>
        <p>Best regards,<br/>Edulocka</p>
      </div>
    `;
  }
  return fs.readFileSync(templatePath, "utf8");
}

/**
 * Notify a student that their certificate has been revoked.
 * Never throws — callers should treat this as fire-and-forget.
 */
async function sendCertificateRevokedEmail({
  to,
  studentName,
  studentId,
  certId,
  degree,
  institution,
  revokedAt,
}) {
  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, error: "Email not configured" };
  }

  if (!to) {
    return { sent: false, error: "No recipient email on file" };
  }

  try {
    const templateSource = loadRevocationTemplate();
    const template = Handlebars.compile(templateSource);

    const html = template({
      studentName,
      studentId: studentId || null,
      certId,
      degree,
      institution,
      revokedAt: revokedAt
        ? new Date(revokedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
        : new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
      verifyUrl: qrService.getVerifyUrl(certId),
      portalUrl: getPortalUrl(),
      currentYear: new Date().getFullYear(),
    });

    const info = await transporter.sendMail({
      from: getFromAddress(),
      to,
      subject: `⚠️ Certificate Revoked — ${institution}`,
      html,
    });

    return { sent: true, messageId: info.messageId, to };
  } catch (err) {
    return { sent: false, to, error: err.message };
  }
}

// ── Bulk send emails ────────────────────────────────────────────────────────

async function bulkSendEmails(emailJobs, onProgress) {
  const results = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < emailJobs.length; i++) {
    const job = emailJobs[i];
    const result = await sendCertificateEmail(job);

    if (result.sent) {
      sent++;
    } else {
      failed++;
    }

    results.push({ index: i, certId: job.certId, ...result });

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: emailJobs.length,
        sent,
        failed,
        percent: Math.round(((i + 1) / emailJobs.length) * 100),
      });
    }

    // Small delay to avoid SMTP rate limits
    if (i < emailJobs.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { results, sent, failed, total: emailJobs.length };
}

// ── Verify SMTP connection ──────────────────────────────────────────────────

async function verifyConnection() {
  const transporter = createTransporter();
  if (!transporter) return { connected: false, reason: "Not configured" };

  try {
    await transporter.verify();
    return { connected: true };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

// ── Institution notification emails ─────────────────────────────────────────

function loadInstitutionTemplate(templateName) {
  const templatePath = path.join(TEMPLATES_DIR, templateName);
  if (!fs.existsSync(templatePath)) return null;
  return fs.readFileSync(templatePath, "utf8");
}

/**
 * Send an institution notification email.
 * Never throws — callers should treat this as fire-and-forget.
 * @param {object} options
 * @param {string} options.to - Recipient email
 * @param {"received"|"approved"|"rejected"} options.type - Notification type
 * @param {object} options.data - { institutionName, walletAddress, reason?, txHash? }
 */
async function sendInstitutionEmail({ to, type, data = {} }) {
  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, error: "Email not configured" };
  }

  if (!to) {
    return { sent: false, error: "No recipient email on file" };
  }

  const subjects = {
    received: `📋 Application Received — ${data.institutionName}`,
    approved: `✅ Institution Authorized — ${data.institutionName}`,
    rejected: `❌ Application Not Approved — ${data.institutionName}`,
  };

  const templateFile = `email-institution-${type}.html`;
  let templateSource = loadInstitutionTemplate(templateFile);

  // Fallback inline templates (used only if the HTML files under backend/templates are missing)
  if (!templateSource) {
    const templates = {
      received: `
        <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#111827;">📋 Application Received</h2>
          <p>Dear <strong>{{institutionName}}</strong>,</p>
          <p>We have received your application for authorization on EduLocka.</p>
          <p><strong>Wallet Address:</strong> <code>{{walletAddress}}</code></p>
          <p>Our team will review your application and supporting documents. You will receive an email once a decision has been made.</p>
          <p>Best regards,<br/>EduLocka Admin Team</p>
        </div>`,
      approved: `
        <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#16a34a;">✅ Application Approved</h2>
          <p>Dear <strong>{{institutionName}}</strong>,</p>
          <p>Congratulations! Your institution has been authorized on the EduLocka blockchain.</p>
          <p><strong>Wallet Address:</strong> <code>{{walletAddress}}</code></p>
          {{#if txHash}}<p><strong>Blockchain TX:</strong> <a href="{{txUrl}}">{{txHash}}</a></p>{{/if}}
          <p><strong>Next steps to start issuing certificates:</strong></p>
          <ol>
            <li>Connect this wallet to the Edulocka portal (Sepolia Test Network): <a href="{{dashboardUrl}}">{{dashboardUrl}}</a></li>
            <li>Create or generate a certificate template: <a href="{{templatesUrl}}">{{templatesUrl}}</a></li>
            <li>Issue your first certificate: <a href="{{issueUrl}}">{{issueUrl}}</a></li>
          </ol>
          <p>Best regards,<br/>EduLocka Admin Team</p>
        </div>`,
      rejected: `
        <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#dc2626;">❌ Application Not Approved</h2>
          <p>Dear <strong>{{institutionName}}</strong>,</p>
          <p>After careful review, we were unable to approve your institution's application at this time.</p>
          {{#if reason}}<p><strong>Reason:</strong> {{reason}}</p>{{/if}}
          <p>You may address the concerns above and reapply at: <a href="{{applyUrl}}">{{applyUrl}}</a></p>
          <p>Best regards,<br/>EduLocka Admin Team</p>
        </div>`,
    };
    templateSource = templates[type] || templates.received;
  }

  const template = Handlebars.compile(templateSource);
  const base = getFrontendBaseUrl();
  const html = template({
    ...data,
    dashboardUrl: `${base}/dashboard`,
    templatesUrl: `${base}/templates`,
    issueUrl: `${base}/issue`,
    applyUrl: `${base}/apply-institution`,
    txUrl: data.txHash ? getExplorerTxUrl(data.txHash) : null,
    currentYear: new Date().getFullYear(),
  });

  try {
    const info = await transporter.sendMail({
      from: getFromAddress(),
      to,
      subject: subjects[type] || "EduLocka Notification",
      html,
    });
    return { sent: true, messageId: info.messageId, to };
  } catch (err) {
    return { sent: false, to, error: err.message };
  }
}

module.exports = {
  sendCertificateEmail,
  sendCertificateRevokedEmail,
  bulkSendEmails,
  verifyConnection,
  isEmailConfigured,
  sendInstitutionEmail,
};
