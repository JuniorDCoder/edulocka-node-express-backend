// ============================================================================
// Institution Routes — Public endpoints for institution applications
// ============================================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const router = express.Router();

const institutionController = require("../controllers/institutionController");
const { requireWalletAuth } = require("../middleware/authMiddleware");

// ── File upload config for institution documents ────────────────────────────
const docStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "..", "..", "uploads", "institution-docs"));
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
router.post("/apply", uploadFields, institutionController.applyForAuthorization);

// Check application status by ID (public)
router.get("/status/:id", institutionController.getApplicationStatus);

// Get institution info for the connected wallet (requires wallet auth)
router.get("/my-info", requireWalletAuth, institutionController.getMyInstitutionInfo);

// Quick authorization check for any address (public, no auth needed)
router.get("/check/:address", institutionController.checkAuthorization);

module.exports = router;
