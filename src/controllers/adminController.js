// ============================================================================
// Admin Controller — Handles admin dashboard endpoints
// ============================================================================
// All endpoints require admin wallet authentication (requireAdminAuth middleware).

const path = require("path");
const fs = require("fs");
const InstitutionApplication = require("../models/InstitutionApplication");
const blockchainService = require("../services/blockchainService");
const { generateVerificationReport } = require("../services/verificationService");
const emailService = require("../services/emailService");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/applications — List applications with filters
// ─────────────────────────────────────────────────────────────────────────────
async function listApplications(req, res) {
  try {
    const { status, page = 1, limit = 20, search } = req.query;

    const query = {};
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { institutionName: { $regex: search, $options: "i" } },
        { registrationNumber: { $regex: search, $options: "i" } },
        { country: { $regex: search, $options: "i" } },
        { walletAddress: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [applications, total] = await Promise.all([
      InstitutionApplication.find(query)
        .sort({ appliedDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .select("-documents"), // Don't send file paths in list view
      InstitutionApplication.countDocuments(query),
    ]);

    res.json({
      applications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/applications/:id — Get full application details
// ─────────────────────────────────────────────────────────────────────────────
async function getApplicationDetails(req, res) {
  try {
    const application = await InstitutionApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    const appObj = application.toObject();

    // Transform document paths into metadata with download URLs
    const VALID_DOC_TYPES = ["registrationCert", "accreditationProof", "letterOfIntent", "idDocument"];
    const documentInfo = {};
    if (appObj.documents) {
      for (const docType of VALID_DOC_TYPES) {
        const filePath = appObj.documents[docType];
        if (filePath && fs.existsSync(filePath)) {
          documentInfo[docType] = {
            exists: true,
            fileName: path.basename(filePath),
            url: `/api/admin/documents/${application._id}/${docType}`,
          };
        }
      }
    }
    appObj.documentInfo = documentInfo;
    // Remove raw file paths from response (security)
    delete appObj.documents;

    res.json(appObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/approve/:id — Approve application & authorize on blockchain
// ─────────────────────────────────────────────────────────────────────────────
async function approveApplication(req, res) {
  try {
    const application = await InstitutionApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (application.status === "approved") {
      return res.status(400).json({ error: "Application is already approved" });
    }

    // Update verification checklist from request body if provided
    if (req.body.verificationChecks) {
      application.verificationChecks = {
        ...application.verificationChecks,
        ...req.body.verificationChecks,
      };
    }

    if (req.body.adminNotes) {
      application.adminNotes = req.body.adminNotes;
    }

    // Authorize on blockchain
    let txResult;
    try {
      txResult = await blockchainService.authorizeInstitution(
        application.walletAddress,
        {
          name: application.institutionName,
          registrationNumber: application.registrationNumber,
          country: application.country,
        }
      );
    } catch (err) {
      return res.status(500).json({
        error: "Blockchain authorization failed",
        details: err.message,
      });
    }

    // Update application status
    application.status = "approved";
    application.reviewedDate = new Date();
    application.reviewedBy = req.adminAddress;
    application.blockchainTxHash = txResult.txHash;
    application.authorizedOnChain = true;
    await application.save();

    // Send approval email (non-blocking)
    try {
      await emailService.sendInstitutionEmail({
        to: application.contactEmail,
        type: "approved",
        data: {
          institutionName: application.institutionName,
          walletAddress: application.walletAddress,
          txHash: txResult.txHash,
        },
      });
    } catch (emailErr) {
      console.error("Failed to send approval email:", emailErr.message);
    }

    res.json({
      success: true,
      applicationId: application._id,
      status: "approved",
      blockchain: {
        txHash: txResult.txHash,
        blockNumber: txResult.blockNumber,
        gasUsed: txResult.gasUsed,
      },
      message: `Institution "${application.institutionName}" has been authorized on the blockchain.`,
    });
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reject/:id — Reject an application
// ─────────────────────────────────────────────────────────────────────────────
async function rejectApplication(req, res) {
  try {
    const { reason, adminNotes } = req.body;

    if (!reason) {
      return res.status(400).json({ error: "Rejection reason is required" });
    }

    const application = await InstitutionApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (application.status === "approved") {
      return res.status(400).json({ error: "Cannot reject an already-approved application" });
    }

    application.status = "rejected";
    application.rejectionReason = reason;
    application.reviewedDate = new Date();
    application.reviewedBy = req.adminAddress;
    if (adminNotes) application.adminNotes = adminNotes;
    await application.save();

    // Send rejection email (non-blocking)
    try {
      await emailService.sendInstitutionEmail({
        to: application.contactEmail,
        type: "rejected",
        data: {
          institutionName: application.institutionName,
          reason,
        },
      });
    } catch (emailErr) {
      console.error("Failed to send rejection email:", emailErr.message);
    }

    res.json({
      success: true,
      applicationId: application._id,
      status: "rejected",
      message: `Application for "${application.institutionName}" has been rejected.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/update-checks/:id — Update verification checklist
// ─────────────────────────────────────────────────────────────────────────────
async function updateChecklist(req, res) {
  try {
    const application = await InstitutionApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (req.body.verificationChecks) {
      application.verificationChecks = {
        ...application.verificationChecks,
        ...req.body.verificationChecks,
      };
    }
    if (req.body.adminNotes !== undefined) {
      application.adminNotes = req.body.adminNotes;
    }
    if (req.body.status === "under_review" && application.status === "pending") {
      application.status = "under_review";
    }

    await application.save();

    res.json({ success: true, verificationChecks: application.verificationChecks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/institutions — List all authorized institutions
// ─────────────────────────────────────────────────────────────────────────────
async function listAuthorizedInstitutions(req, res) {
  try {
    // Get from blockchain
    let blockchainInstitutions = [];
    try {
      blockchainInstitutions = await blockchainService.getAllInstitutions();
    } catch {
      // Blockchain not available
    }

    // Get approved applications from DB for extra metadata
    const dbInstitutions = await InstitutionApplication.find({ status: "approved" })
      .select("institutionName walletAddress country registrationNumber blockchainTxHash appliedDate reviewedDate")
      .sort({ reviewedDate: -1 });

    res.json({
      blockchain: blockchainInstitutions,
      database: dbInstitutions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/deauthorize/:address — Remove institution from blockchain
// ─────────────────────────────────────────────────────────────────────────────
async function deauthorizeInstitution(req, res) {
  try {
    const { address } = req.params;
    const { reason } = req.body;

    // Remove from blockchain
    let txResult;
    try {
      txResult = await blockchainService.deauthorizeInstitution(address);
    } catch (err) {
      return res.status(500).json({
        error: "Blockchain deauthorization failed",
        details: err.message,
      });
    }

    // Update DB application if exists
    await InstitutionApplication.findOneAndUpdate(
      { walletAddress: address.toLowerCase() },
      {
        status: "rejected",
        rejectionReason: reason || "Deauthorized by admin",
        authorizedOnChain: false,
        reviewedDate: new Date(),
        reviewedBy: req.adminAddress,
      }
    );

    res.json({
      success: true,
      address,
      blockchain: {
        txHash: txResult.txHash,
        blockNumber: txResult.blockNumber,
      },
      message: `Institution at ${address} has been deauthorized.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/stats — Dashboard statistics
// ─────────────────────────────────────────────────────────────────────────────
async function getStats(req, res) {
  try {
    const [pendingCount, underReviewCount, approvedCount, rejectedCount, totalApps, recentApplications] = await Promise.all([
      InstitutionApplication.countDocuments({ status: "pending" }),
      InstitutionApplication.countDocuments({ status: "under_review" }),
      InstitutionApplication.countDocuments({ status: "approved" }),
      InstitutionApplication.countDocuments({ status: "rejected" }),
      InstitutionApplication.countDocuments(),
      InstitutionApplication.find()
        .sort({ appliedDate: -1 })
        .limit(5)
        .select("institutionName walletAddress status country appliedDate"),
    ]);

    let blockchainStats = { totalCertificates: 0, totalInstitutions: 0, totalRevocations: 0 };
    try {
      blockchainStats = await blockchainService.getStats();
    } catch {
      // Blockchain not available
    }

    res.json({
      totalApplications: totalApps,
      pending: pendingCount,
      underReview: underReviewCount,
      approved: approvedCount,
      rejected: rejectedCount,
      totalOnChainInstitutions: blockchainStats.totalInstitutions,
      recentApplications,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/report/:id — Generate verification report
// ─────────────────────────────────────────────────────────────────────────────
async function getVerificationReport(req, res) {
  try {
    const application = await InstitutionApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    const report = generateVerificationReport(application);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/documents/:id/:docType — Serve an uploaded document file
// ─────────────────────────────────────────────────────────────────────────────
const VALID_DOC_TYPES = ["registrationCert", "accreditationProof", "letterOfIntent", "idDocument"];
const DOC_LABELS = {
  registrationCert: "Registration Certificate",
  accreditationProof: "Accreditation Proof",
  letterOfIntent: "Letter of Intent",
  idDocument: "ID Document",
};

async function serveDocument(req, res) {
  try {
    const { id, docType } = req.params;

    if (!VALID_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ error: "Invalid document type" });
    }

    const application = await InstitutionApplication.findById(id).select("documents");
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    const filePath = application.documents?.[docType];
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Determine content type from extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".pdf": "application/pdf",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";
    const fileName = `${DOC_LABELS[docType] || docType}${ext}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  listApplications,
  getApplicationDetails,
  approveApplication,
  rejectApplication,
  updateChecklist,
  listAuthorizedInstitutions,
  deauthorizeInstitution,
  getStats,
  getVerificationReport,
  serveDocument,
};
