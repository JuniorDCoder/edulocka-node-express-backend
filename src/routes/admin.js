// ============================================================================
// Admin Routes — Protected endpoints for the Edulocka admin dashboard
// ============================================================================
// All routes require admin wallet authentication.

const express = require("express");
const router = express.Router();

const adminController = require("../controllers/adminController");
const blogController = require("../controllers/blogController");
const { requireAdminAuth } = require("../middleware/adminMiddleware");

// All admin routes require authentication
router.use(requireAdminAuth);

// ── Application Management ──────────────────────────────────────────────────

// List all applications (with filters: ?status=pending&search=MIT&page=1)
router.get("/applications", adminController.listApplications);

// Get full application details
router.get("/applications/:id", adminController.getApplicationDetails);

// Approve an application (calls blockchain to authorize)
router.post("/approve/:id", adminController.approveApplication);

// Reject an application (requires reason in body)
router.post("/reject/:id", adminController.rejectApplication);

// Update verification checklist for an application
router.post("/update-checks/:id", adminController.updateChecklist);

// Generate verification report
router.get("/report/:id", adminController.getVerificationReport);

// Serve uploaded document files
router.get("/documents/:id/:docType", adminController.serveDocument);

// ── Institution Management ──────────────────────────────────────────────────

// List all authorized institutions (from blockchain + database)
router.get("/institutions", adminController.listAuthorizedInstitutions);

// Deauthorize an institution (removes from blockchain)
router.post("/deauthorize/:address", adminController.deauthorizeInstitution);

// ── Dashboard Stats ─────────────────────────────────────────────────────────
router.get("/stats", adminController.getStats);

// ── Blog Management ─────────────────────────────────────────────────────────
router.get("/blogs", blogController.listBlogsForAdmin);
router.get("/blog-logs", blogController.listBlogAuditLogs);
router.post("/blogs/:id/review", blogController.reviewBlog);
router.delete("/blogs/:id", blogController.deleteBlog);

module.exports = router;
