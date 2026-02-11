// ============================================================================
// API Routes — All endpoints for the Edulocka backend
// ============================================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const router = express.Router();

const bulkController = require("../controllers/bulkController");
const certificateController = require("../controllers/certificateController");
const blogController = require("../controllers/blogController");
const { requireWalletAuth, optionalWalletAuth } = require("../middleware/authMiddleware");
const { requireAdminAuth } = require("../middleware/adminMiddleware");

// ── File upload config ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "..", "..", "uploads"));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const csvUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".csv" || ext === ".xlsx" || ext === ".xls") {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and Excel files are allowed"));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const templateUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only HTML, PDF, and image files are allowed"));
    }
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

const certificateVerifyUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isPdf = ext === ".pdf" || file.mimetype === "application/pdf";
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF certificate files are allowed"));
    }
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// ─────────────────────────────────────────────────────────────────────────────
// BULK ISSUANCE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Upload & validate CSV → returns preview with validation results
router.post("/bulk/upload", csvUpload.single("file"), bulkController.uploadCSV);

// Process the validated batch → issues on blockchain, generates PDFs, etc.
router.post("/bulk/process", bulkController.processBatch);

// Get status of an in-progress bulk job
router.get("/bulk/status/:jobId", bulkController.getJobStatus);

// Download all generated certificates for a job as ZIP
router.get("/bulk/download/:jobId", bulkController.downloadBatch);

// ─────────────────────────────────────────────────────────────────────────────
// BLOG ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Writer routes (wallet auth required)
router.get("/blogs/my", requireWalletAuth, blogController.listMyBlogs);
router.get("/blogs/my/:id", requireWalletAuth, blogController.getMyBlogById);
router.post("/blogs", requireWalletAuth, blogController.createBlog);
router.put("/blogs/:id", requireWalletAuth, blogController.updateBlog);
router.delete("/blogs/:id", requireWalletAuth, blogController.deleteBlog);

// Admin moderation routes
router.get("/blogs/pending-review", requireAdminAuth, blogController.listPendingReviewBlogs);
router.post("/blogs/:id/review", requireAdminAuth, blogController.reviewBlog);

// Public blog feed + detail (published only)
router.get("/blogs", blogController.listPublishedBlogs);
router.get("/blogs/:slug", blogController.getPublishedBlog);

// ─────────────────────────────────────────────────────────────────────────────
// CERTIFICATE TEMPLATE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Upload a custom certificate HTML template (requires wallet auth)
router.post(
  "/templates/upload",
  requireWalletAuth,
  templateUpload.single("template"),
  certificateController.uploadTemplate
);

// List available templates (optional auth — defaults for all, + institution-specific when authenticated)
router.get("/templates", optionalWalletAuth, certificateController.listTemplates);

// Preview a template with sample data (optional auth for institution templates)
router.post("/templates/preview", optionalWalletAuth, certificateController.previewTemplate);

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE CERTIFICATE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Issue a single certificate (with PDF + QR + optional email)
router.post("/certificates/issue", certificateController.issueSingle);

// Verify a certificate by ID
router.get("/certificates/verify/:certId", certificateController.verifyCertificate);

// Verify an uploaded certificate document by hashing and comparing with on-chain IPFS file
router.post(
  "/certificates/verify-file",
  certificateVerifyUpload.single("document"),
  certificateController.verifyCertificateDocument
);

// Generate PDF for an existing certificate
router.get("/certificates/:certId/pdf", certificateController.generatePDF);

// ─────────────────────────────────────────────────────────────────────────────
// QR CODE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Generate QR code for a single certificate
router.get("/qr/:certId", certificateController.getQRCode);

// Bulk export QR codes as ZIP
router.post("/qr/bulk-export", certificateController.bulkExportQR);

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Send certificate email to a single student
router.post("/email/send", certificateController.sendEmail);

// Bulk send emails for a job
router.post("/email/bulk-send/:jobId", certificateController.bulkSendEmails);

// ─────────────────────────────────────────────────────────────────────────────
// REPORT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Generate Excel report for a batch job
router.get("/reports/:jobId", bulkController.generateReport);

module.exports = router;
