// ============================================================================
// Institution Controller — Handles institution application endpoints
// ============================================================================

const InstitutionApplication = require("../models/InstitutionApplication");
const { validateApplication } = require("../services/verificationService");
const blockchainService = require("../services/blockchainService");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/institution/apply — Submit a new institution application
// ─────────────────────────────────────────────────────────────────────────────
async function applyForAuthorization(req, res) {
  try {
    const {
      institutionName,
      registrationNumber,
      country,
      walletAddress,
      contactEmail,
      contactPhone,
      physicalAddress,
      website,
      authorizedPersonName,
      authorizedPersonTitle,
    } = req.body;

    // Validate input
    const validation = validateApplication(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: "Validation failed", errors: validation.errors });
    }

    // Check if application already exists for this wallet
    const existing = await InstitutionApplication.findOne({
      walletAddress: walletAddress.toLowerCase(),
      status: { $in: ["pending", "under_review", "approved"] },
    });

    if (existing) {
      return res.status(409).json({
        error: "An application already exists for this wallet address",
        existingStatus: existing.status,
        applicationId: existing._id,
      });
    }

    // Check if already authorized on blockchain
    try {
      const isAuth = await blockchainService.checkIfAuthorized(walletAddress);
      if (isAuth) {
        return res.status(409).json({
          error: "This wallet is already authorized on the blockchain",
        });
      }
    } catch {
      // Blockchain check failed — proceed anyway (manual verification will catch it)
    }

    // Handle document uploads (files come via multer)
    const documents = {};
    if (req.files) {
      if (req.files.registrationCert) documents.registrationCert = req.files.registrationCert[0].path;
      if (req.files.accreditationProof) documents.accreditationProof = req.files.accreditationProof[0].path;
      if (req.files.letterOfIntent) documents.letterOfIntent = req.files.letterOfIntent[0].path;
      if (req.files.idDocument) documents.idDocument = req.files.idDocument[0].path;
    }

    // Create application
    const application = new InstitutionApplication({
      institutionName: institutionName.trim(),
      registrationNumber: registrationNumber.trim(),
      country: country.trim(),
      walletAddress: walletAddress.toLowerCase(),
      contactEmail: contactEmail.trim().toLowerCase(),
      contactPhone: contactPhone?.trim(),
      physicalAddress: physicalAddress?.trim(),
      website: website?.trim(),
      authorizedPersonName: authorizedPersonName.trim(),
      authorizedPersonTitle: authorizedPersonTitle?.trim(),
      documents,
    });

    await application.save();

    res.status(201).json({
      success: true,
      applicationId: application._id,
      status: application.status,
      message: "Application submitted successfully. You will be notified when it is reviewed.",
    });
  } catch (err) {
    console.error("Apply error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "An application already exists for this wallet address" });
    }
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/institution/status/:id — Check application status
// ─────────────────────────────────────────────────────────────────────────────
async function getApplicationStatus(req, res) {
  try {
    const { id } = req.params;
    const application = await InstitutionApplication.findById(id).select(
      "institutionName status appliedDate reviewedDate rejectionReason blockchainTxHash authorizedOnChain"
    );

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    res.json({
      applicationId: application._id,
      institutionName: application.institutionName,
      status: application.status,
      appliedDate: application.appliedDate,
      reviewedDate: application.reviewedDate,
      rejectionReason: application.rejectionReason,
      blockchainTxHash: application.blockchainTxHash,
      authorizedOnChain: application.authorizedOnChain,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/institution/my-info — Get institution info for connected wallet
// ─────────────────────────────────────────────────────────────────────────────
async function getMyInstitutionInfo(req, res) {
  try {
    const walletAddress = req.walletAddress; // Set by authMiddleware

    // Check blockchain authorization
    let blockchainInfo = null;
    try {
      blockchainInfo = await blockchainService.getInstitutionInfo(walletAddress);
    } catch {
      // Blockchain not available
    }

    // Get application from database
    const application = await InstitutionApplication.findOne({
      walletAddress: walletAddress.toLowerCase(),
    }).sort({ createdAt: -1 });

    res.json({
      walletAddress,
      application: application
        ? {
            id: application._id,
            institutionName: application.institutionName,
            registrationNumber: application.registrationNumber,
            country: application.country,
            status: application.status,
            appliedDate: application.appliedDate,
            authorizedOnChain: application.authorizedOnChain,
          }
        : null,
      blockchain: blockchainInfo,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/institution/check/:address — Quick auth check (no wallet sig needed)
// ─────────────────────────────────────────────────────────────────────────────
async function checkAuthorization(req, res) {
  try {
    const { address } = req.params;

    let isAuthorized = false;
    let institutionInfo = null;

    try {
      isAuthorized = await blockchainService.checkIfAuthorized(address);
      if (isAuthorized) {
        institutionInfo = await blockchainService.getInstitutionInfo(address);
      }
    } catch {
      // Blockchain not available
    }

    res.json({
      address,
      isAuthorized,
      institution: institutionInfo,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  applyForAuthorization,
  getApplicationStatus,
  getMyInstitutionInfo,
  checkAuthorization,
};
