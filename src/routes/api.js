// ============================================================================
// API Routes — All endpoints for the Edulocka backend
// ============================================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const router = express.Router();

const bulkController = require("../controllers/bulkController");
const certificateController = require("../controllers/certificateController");
const blogController = require("../controllers/blogController");
const { requireWalletAuth, optionalWalletAuth } = require("../middleware/authMiddleware");
const { requireAdminAuth } = require("../middleware/adminMiddleware");
const { ensureDirSync, getUploadsDir } = require("../utils/runtimePaths");

// ── File upload config ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getUploadsDir();
    if (!fs.existsSync(uploadDir)) ensureDirSync(uploadDir);
    cb(null, uploadDir);
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
/**
 * @openapi
 * /api/blogs:
 *   get:
 *     tags: [Blogs]
 *     summary: List published blogs
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, example: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, example: 24 }
 *       - in: query
 *         name: search
 *         schema: { type: string, example: blockchain }
 *       - in: query
 *         name: tag
 *         schema: { type: string, example: education }
 *     responses:
 *       200:
 *         description: Blog list
 *       503:
 *         description: Database unavailable
 */
router.get("/blogs", blogController.listPublishedBlogs);
/**
 * @openapi
 * /api/blogs/{slug}:
 *   get:
 *     tags: [Blogs]
 *     summary: Get a published blog by slug
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Blog detail
 *       404:
 *         description: Not found
 *       503:
 *         description: Database unavailable
 */
router.get("/blogs/:slug", blogController.getPublishedBlog);

// ─────────────────────────────────────────────────────────────────────────────
// CERTIFICATE TEMPLATE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Upload a custom certificate HTML template (requires wallet auth)
/**
 * @openapi
 * /api/templates/upload:
 *   post:
 *     tags: [Templates]
 *     summary: Upload a custom certificate template for a wallet
 *     security:
 *       - WalletAddress: []
 *         WalletSignature: []
 *         WalletMessage: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               template:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Template uploaded
 *       401:
 *         description: Wallet auth required
 */
router.post(
  "/templates/upload",
  requireWalletAuth,
  templateUpload.single("template"),
  certificateController.uploadTemplate
);

// List available templates (optional auth — defaults for all, + institution-specific when authenticated)
/**
 * @openapi
 * /api/templates:
 *   get:
 *     tags: [Templates]
 *     summary: List certificate templates (default + institution-specific if wallet header provided)
 *     parameters:
 *       - in: header
 *         name: x-wallet-address
 *         required: false
 *         schema: { type: string, example: "0x0000000000000000000000000000000000000000" }
 *     responses:
 *       200:
 *         description: Template list
 */
router.get("/templates", optionalWalletAuth, certificateController.listTemplates);

// Preview a template with sample data (optional auth for institution templates)
router.post("/templates/preview", optionalWalletAuth, certificateController.previewTemplate);

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE CERTIFICATE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Issue a single certificate (with PDF + QR + optional email)
/**
 * @openapi
 * /api/certificates/issue:
 *   post:
 *     tags: [Certificates]
 *     summary: Issue a single certificate (generates PDF + QR, uploads to IPFS, anchors on-chain)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentName, studentId, degree, institution, issueDate]
 *             properties:
 *               studentName: { type: string }
 *               studentId: { type: string }
 *               degree: { type: string }
 *               institution: { type: string }
 *               issueDate: { type: string, example: "2026-03-25" }
 *               email: { type: string, example: "student@example.com" }
 *               templateName: { type: string, example: "default-certificate" }
 *     responses:
 *       200:
 *         description: Issued successfully
 *       400:
 *         description: Validation error
 */
router.post("/certificates/issue", certificateController.issueSingle);

// Verify a certificate by ID
/**
 * @openapi
 * /api/certificates/verify/{certId}:
 *   get:
 *     tags: [Certificates]
 *     summary: Verify a certificate on-chain by certificate ID
 *     parameters:
 *       - in: path
 *         name: certId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Verification result
 *       404:
 *         description: Not found on chain
 */
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
