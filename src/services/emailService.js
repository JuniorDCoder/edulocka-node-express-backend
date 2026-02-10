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

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null; // Email not configured
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
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
      error: "Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env",
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
    certId,
    degree,
    institution,
    issueDate: formattedDate,
    verifyUrl,
    qrDataUrl,
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
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
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
 * @param {string} to - Recipient email
 * @param {"received"|"approved"|"rejected"} type - Notification type
 * @param {object} data - { institutionName, walletAddress, reason?, txHash? }
 */
async function sendInstitutionEmail(to, type, data) {
  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, error: "Email not configured" };
  }

  const subjects = {
    received: `📋 Application Received — ${data.institutionName}`,
    approved: `✅ Institution Authorized — ${data.institutionName}`,
    rejected: `❌ Application Not Approved — ${data.institutionName}`,
  };

  const templateFile = `institution-${type}.html`;
  let templateSource = loadInstitutionTemplate(templateFile);

  // Fallback inline templates
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
          {{#if txHash}}<p><strong>Blockchain TX:</strong> <code>{{txHash}}</code></p>{{/if}}
          <p>You can now issue certificates through the EduLocka platform.</p>
          <p>Best regards,<br/>EduLocka Admin Team</p>
        </div>`,
      rejected: `
        <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#dc2626;">❌ Application Not Approved</h2>
          <p>Dear <strong>{{institutionName}}</strong>,</p>
          <p>After careful review, we were unable to approve your institution's application at this time.</p>
          {{#if reason}}<p><strong>Reason:</strong> {{reason}}</p>{{/if}}
          <p>You may address the concerns and reapply.</p>
          <p>Best regards,<br/>EduLocka Admin Team</p>
        </div>`,
    };
    templateSource = templates[type] || templates.received;
  }

  const template = Handlebars.compile(templateSource);
  const html = template({
    ...data,
    currentYear: new Date().getFullYear(),
  });

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
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
  bulkSendEmails,
  verifyConnection,
  isEmailConfigured,
  sendInstitutionEmail,
};
