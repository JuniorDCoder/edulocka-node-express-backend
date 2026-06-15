// ============================================================================
// Admin Controller — Handles admin dashboard endpoints
// ============================================================================
// All endpoints require admin wallet authentication (requireAdminAuth middleware).

const path = require("path");
const fs = require("fs");
const InstitutionApplication = require("../models/InstitutionApplication");
const Certificate = require("../models/Certificate");
const blockchainService = require("../services/blockchainService");
const { generateVerificationReport } = require("../services/verificationService");
const emailService = require("../services/emailService");
const { isServerlessRuntime } = require("../utils/runtimePaths");

// Escape special regex chars in user-provided search strings.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Mirrors certificateController's deliverEmail: await on serverless (function
// may freeze right after res.json()), fire-and-forget on long-lived servers.
async function deliverEmail(promise, label) {
  if (isServerlessRuntime()) {
    try {
      await promise;
    } catch (err) {
      console.error(`${label} failed (non-blocking):`, err);
    }
  } else {
    promise.catch((err) => {
      console.error(`${label} failed (non-blocking):`, err);
    });
  }
}

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
        deauthorizedAt: new Date(),
        deauthorizedBy: req.adminAddress,
        deauthorizedTxHash: txResult.txHash,
        deauthorizedBlockNumber: txResult.blockNumber,
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
// POST /api/admin/sync-to-blockchain — Authorize approved institutions on-chain
// ─────────────────────────────────────────────────────────────────────────────
// FIXES: Institutions that are approved in DB but not yet authorized on-chain
async function syncApprovedInstitutionsToBlockchain(req, res) {
  try {
    // Find all approved institutions that are NOT yet authorized on-chain
    const unapprovedInstitutions = await InstitutionApplication.find({
      status: "approved",
      authorizedOnChain: { $ne: true },
    });

    if (unapprovedInstitutions.length === 0) {
      return res.json({
        success: true,
        message: "All approved institutions are already authorized on-chain.",
        synced: [],
        failed: [],
      });
    }

    const synced = [];
    const failed = [];

    console.log(`🔗 Syncing ${unapprovedInstitutions.length} institutions to blockchain...`);

    // Authorize each institution on-chain
    for (const app of unapprovedInstitutions) {
      try {
        console.log(`  ➜ Authorizing: ${app.institutionName} (${app.walletAddress})`);

        const txResult = await blockchainService.authorizeInstitution(
          app.walletAddress,
          {
            name: app.institutionName,
            registrationNumber: app.registrationNumber,
            country: app.country,
          }
        );

        // Update DB to mark as authorized on-chain
        app.authorizedOnChain = true;
        app.blockchainTxHash = txResult.txHash;
        await app.save();

        synced.push({
          id: app._id,
          name: app.institutionName,
          wallet: app.walletAddress,
          txHash: txResult.txHash,
          blockNumber: txResult.blockNumber,
        });

        console.log(`  ✅ ${app.institutionName} → ${txResult.txHash}`);
      } catch (err) {
        failed.push({
          id: app._id,
          name: app.institutionName,
          wallet: app.walletAddress,
          error: err.message,
        });

        console.error(`  ❌ ${app.institutionName}: ${err.message}`);
      }
    }

    res.json({
      success: true,
      message: `Synced ${synced.length} institutions to blockchain.${failed.length > 0 ? ` ${failed.length} failed.` : ""}`,
      synced,
      failed,
    });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/stats — Dashboard statistics
// ─────────────────────────────────────────────────────────────────────────────
async function getStats(req, res) {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);

    const [
      pendingCount,
      underReviewCount,
      approvedCount,
      rejectedCount,
      totalApps,
      recentApplications,
      totalCertificates,
      issuedCertificates,
      revokedCertificates,
      certificatesThisMonth,
      certificatesThisWeek,
      emailsSent,
      emailsFailed,
      studentIds,
      recentCertificates,
      topInstitutions,
    ] = await Promise.all([
      InstitutionApplication.countDocuments({ status: "pending" }),
      InstitutionApplication.countDocuments({ status: "under_review" }),
      InstitutionApplication.countDocuments({ status: "approved" }),
      InstitutionApplication.countDocuments({ status: "rejected" }),
      InstitutionApplication.countDocuments(),
      InstitutionApplication.find()
        .sort({ appliedDate: -1 })
        .limit(5)
        .select("institutionName walletAddress status country appliedDate"),
      Certificate.countDocuments(),
      Certificate.countDocuments({ status: "issued" }),
      Certificate.countDocuments({ status: "revoked" }),
      Certificate.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Certificate.countDocuments({ createdAt: { $gte: startOfWeek } }),
      Certificate.countDocuments({ "email.sent": true }),
      Certificate.countDocuments({ studentEmail: { $nin: [null, ""] }, "email.sent": false }),
      Certificate.distinct("studentId", { studentId: { $nin: [null, ""] } }),
      Certificate.find()
        .sort({ createdAt: -1 })
        .limit(8)
        .select("certId studentName studentId institution degree status createdAt"),
      Certificate.aggregate([
        {
          $group: {
            _id: "$institution",
            total: { $sum: 1 },
            issued: { $sum: { $cond: [{ $eq: ["$status", "issued"] }, 1, 0] } },
            revoked: { $sum: { $cond: [{ $eq: ["$status", "revoked"] }, 1, 0] } },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 8 },
        { $project: { _id: 0, institution: "$_id", total: 1, issued: 1, revoked: 1 } },
      ]),
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
      certificates: {
        total: totalCertificates,
        issued: issuedCertificates,
        revoked: revokedCertificates,
        issuedThisMonth: certificatesThisMonth,
        issuedThisWeek: certificatesThisWeek,
        emailsSent,
        emailsFailed,
        recent: recentCertificates,
        topInstitutions,
      },
      students: {
        total: studentIds.length,
      },
      blockchain: blockchainStats,
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/certificates — List all certificates (filters: status, institution, search)
// ─────────────────────────────────────────────────────────────────────────────
async function listCertificates(req, res) {
  try {
    const { status, institution, search, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status === "issued" || status === "revoked") query.status = status;
    if (institution) query.institution = { $regex: escapeRegex(institution), $options: "i" };
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { certId: re },
        { studentName: re },
        { studentId: re },
        { studentEmail: re },
        { institution: re },
        { degree: re },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [certificates, total] = await Promise.all([
      Certificate.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      Certificate.countDocuments(query),
    ]);

    res.json({
      certificates,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/certificates/:certId — Full certificate record
// ─────────────────────────────────────────────────────────────────────────────
async function getCertificateDetails(req, res) {
  try {
    const { certId } = req.params;
    const certificate = await Certificate.findOne({ certId });
    if (!certificate) {
      return res.status(404).json({ error: "Certificate not found" });
    }
    res.json({ certificate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/certificates/:certId/revoke — Admin-level revoke (any institution)
// ─────────────────────────────────────────────────────────────────────────────
async function revokeCertificate(req, res) {
  try {
    const { certId } = req.params;

    const cert = await Certificate.findOne({ certId });
    if (!cert) {
      return res.status(404).json({ error: "Certificate not found" });
    }
    if (cert.status === "revoked") {
      return res.status(409).json({ error: "Certificate is already revoked" });
    }

    const result = await blockchainService.revokeCertificate(certId);

    const revokedAt = new Date();
    await Certificate.updateOne(
      { certId },
      {
        status: "revoked",
        revokedAt,
        revokedBy: `admin:${req.adminAddress}`,
        revokedTxHash: result.txHash,
        revokedBlockNumber: result.blockNumber,
      }
    );

    if (cert.studentEmail) {
      await deliverEmail(
        emailService.sendCertificateRevokedEmail({
          to: cert.studentEmail,
          studentName: cert.studentName,
          studentId: cert.studentId,
          certId,
          degree: cert.degree,
          institution: cert.institution,
          revokedAt,
        }),
        "Admin revocation email send"
      );
    }

    res.json({
      success: true,
      certId,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      message: "Certificate revoked successfully",
    });
  } catch (err) {
    console.error("Admin revoke certificate error:", err);
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/students — Aggregate unique students across all institutions
// ─────────────────────────────────────────────────────────────────────────────
async function listStudents(req, res) {
  try {
    const { search, page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const matchStage = { studentId: { $nin: [null, ""] } };
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      matchStage.$or = [{ studentId: re }, { studentName: re }, { studentEmail: re }];
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: { $toUpper: "$studentId" },
          studentId: { $first: "$studentId" },
          studentName: { $first: "$studentName" },
          studentEmail: { $first: "$studentEmail" },
          institutions: { $addToSet: "$institution" },
          totalCertificates: { $sum: 1 },
          issuedCount: { $sum: { $cond: [{ $eq: ["$status", "issued"] }, 1, 0] } },
          revokedCount: { $sum: { $cond: [{ $eq: ["$status", "revoked"] }, 1, 0] } },
          lastIssuedAt: { $max: "$createdAt" },
        },
      },
      { $sort: { lastIssuedAt: -1 } },
      {
        $facet: {
          students: [{ $skip: skip }, { $limit: limitNum }, { $project: { _id: 0 } }],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const [result] = await Certificate.aggregate(pipeline);
    const students = result?.students || [];
    const total = result?.totalCount?.[0]?.count || 0;

    res.json({
      students,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/students/:studentId — Full certificate history for a student
// ─────────────────────────────────────────────────────────────────────────────
async function getStudentDetails(req, res) {
  try {
    const { studentId } = req.params;
    const re = new RegExp(`^${escapeRegex(studentId)}$`, "i");

    const certificates = await Certificate.find({ studentId: re }).sort({ createdAt: -1 });

    if (certificates.length === 0) {
      return res.status(404).json({ error: "No certificates found for this student ID" });
    }

    const institutionMap = {};
    for (const cert of certificates) {
      if (!institutionMap[cert.institution]) {
        institutionMap[cert.institution] = { name: cert.institution, count: 0 };
      }
      institutionMap[cert.institution].count += 1;
    }

    res.json({
      studentId: certificates[0].studentId,
      studentName: certificates[0].studentName,
      studentEmail: certificates[0].studentEmail,
      institutions: Object.values(institutionMap),
      stats: {
        total: certificates.length,
        issued: certificates.filter((c) => c.status === "issued").length,
        revoked: certificates.filter((c) => c.status === "revoked").length,
      },
      certificates,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/transactions — Unified, platform-wide on-chain transaction feed
// ─────────────────────────────────────────────────────────────────────────────
// Aggregates every on-chain transaction the backend has recorded — certificate
// issuance/revocation and institution authorization/deauthorization — along
// with the wallets/users involved, so the admin can audit everything and jump
// to Etherscan. Built from existing collections; no separate ledger needed.
const TRANSACTION_TYPES = [
  "certificate_issued",
  "certificate_revoked",
  "institution_authorized",
  "institution_deauthorized",
];

async function listTransactions(req, res) {
  try {
    const { type, search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [certs, applications] = await Promise.all([
      Certificate.find()
        .select(
          "certId studentName studentId studentWallet institution status blockchain revokedAt revokedBy revokedTxHash revokedBlockNumber createdAt"
        )
        .sort({ createdAt: -1 })
        .limit(2000)
        .lean(),
      InstitutionApplication.find({
        $or: [{ blockchainTxHash: { $ne: null } }, { deauthorizedTxHash: { $ne: null } }],
      })
        .select(
          "institutionName walletAddress blockchainTxHash reviewedDate reviewedBy deauthorizedAt deauthorizedBy deauthorizedTxHash deauthorizedBlockNumber createdAt"
        )
        .lean(),
    ]);

    const transactions = [];

    for (const cert of certs) {
      if (cert.blockchain?.txHash) {
        transactions.push({
          type: "certificate_issued",
          txHash: cert.blockchain.txHash,
          blockNumber: cert.blockchain.blockNumber ?? null,
          timestamp: cert.blockchain.issuedAt || cert.createdAt,
          certId: cert.certId,
          studentName: cert.studentName,
          studentId: cert.studentId,
          studentWallet: cert.studentWallet,
          institution: cert.institution,
        });
      }
      if (cert.status === "revoked" && cert.revokedTxHash) {
        transactions.push({
          type: "certificate_revoked",
          txHash: cert.revokedTxHash,
          blockNumber: cert.revokedBlockNumber ?? null,
          timestamp: cert.revokedAt || cert.createdAt,
          certId: cert.certId,
          studentName: cert.studentName,
          studentId: cert.studentId,
          studentWallet: cert.studentWallet,
          institution: cert.institution,
          actor: cert.revokedBy,
        });
      }
    }

    for (const app of applications) {
      if (app.blockchainTxHash) {
        transactions.push({
          type: "institution_authorized",
          txHash: app.blockchainTxHash,
          blockNumber: null,
          timestamp: app.reviewedDate || app.createdAt,
          institution: app.institutionName,
          walletAddress: app.walletAddress,
          actor: app.reviewedBy,
        });
      }
      if (app.deauthorizedTxHash) {
        transactions.push({
          type: "institution_deauthorized",
          txHash: app.deauthorizedTxHash,
          blockNumber: app.deauthorizedBlockNumber ?? null,
          timestamp: app.deauthorizedAt || app.createdAt,
          institution: app.institutionName,
          walletAddress: app.walletAddress,
          actor: app.deauthorizedBy,
        });
      }
    }

    let filtered = transactions;

    if (type && TRANSACTION_TYPES.includes(type)) {
      filtered = filtered.filter((t) => t.type === type);
    }

    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      filtered = filtered.filter((t) =>
        [t.certId, t.studentName, t.studentId, t.studentWallet, t.institution, t.walletAddress, t.txHash, t.actor]
          .filter(Boolean)
          .some((field) => re.test(String(field)))
      );
    }

    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const pageItems = filtered.slice(start, start + limitNum);

    res.json({
      transactions: pageItems,
      pagination: { page: pageNum, limit: limitNum, total, pages },
      counts: {
        certificate_issued: transactions.filter((t) => t.type === "certificate_issued").length,
        certificate_revoked: transactions.filter((t) => t.type === "certificate_revoked").length,
        institution_authorized: transactions.filter((t) => t.type === "institution_authorized").length,
        institution_deauthorized: transactions.filter((t) => t.type === "institution_deauthorized").length,
      },
    });
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
  syncApprovedInstitutionsToBlockchain,
  getStats,
  getVerificationReport,
  serveDocument,
  listCertificates,
  getCertificateDetails,
  revokeCertificate,
  listStudents,
  getStudentDetails,
  listTransactions,
};
