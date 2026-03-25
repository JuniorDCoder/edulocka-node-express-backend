// ============================================================================
// Institution Routes — Public endpoints for institution applications
// ============================================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const router = express.Router();

const institutionController = require("../controllers/institutionController");
const { requireWalletAuth } = require("../middleware/authMiddleware");
const { ensureDirSync, getInstitutionDocsDir } = require("../utils/runtimePaths");

// ── File upload config for institution documents ────────────────────────────
const docStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const docDir = getInstitutionDocsDir();
    if (!fs.existsSync(docDir)) ensureDirSync(docDir);
    cb(null, docDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const docUpload = multer({
  storage: docStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed for institutional documents"));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
});

const uploadFields = docUpload.fields([
  { name: "registrationCert", maxCount: 1 },
  { name: "accreditationProof", maxCount: 1 },
  { name: "letterOfIntent", maxCount: 1 },
  { name: "idDocument", maxCount: 1 },
]);

// ── Routes ──────────────────────────────────────────────────────────────────

// Submit a new institution application (public — with optional doc uploads)
/**
 * @openapi
 * /api/institution/apply:
 *   post:
 *     tags: [Institutions]
 *     summary: Submit an institution application (with optional PDF uploads)
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               registrationCert: { type: string, format: binary }
 *               accreditationProof: { type: string, format: binary }
 *               letterOfIntent: { type: string, format: binary }
 *               idDocument: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Application submitted
 */
router.post("/apply", uploadFields, institutionController.applyForAuthorization);

// Check application status by ID (public)
/**
 * @openapi
 * /api/institution/status/{id}:
 *   get:
 *     tags: [Institutions]
 *     summary: Get institution application status by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Application status
 *       404:
 *         description: Not found
 */
router.get("/status/:id", institutionController.getApplicationStatus);

// Get institution info for the connected wallet (requires wallet auth)
/**
 * @openapi
 * /api/institution/my-info:
 *   get:
 *     tags: [Institutions]
 *     summary: Get institution info for the authenticated wallet
 *     security:
 *       - WalletAddress: []
 *         WalletSignature: []
 *         WalletMessage: []
 *     responses:
 *       200:
 *         description: Institution info
 *       401:
 *         description: Wallet auth required
 */
router.get("/my-info", requireWalletAuth, institutionController.getMyInstitutionInfo);

// Quick authorization check for any address (public, no auth needed)
/**
 * @openapi
 * /api/institution/check/{address}:
 *   get:
 *     tags: [Institutions]
 *     summary: Check authorization status for a wallet address
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Authorization status
 */
router.get("/check/:address", institutionController.checkAuthorization);

module.exports = router;
