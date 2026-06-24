const express = require("express");
const router = express.Router();
const studentController = require("../controllers/studentController");
const { requireStudentAuth } = require("../middleware/studentAuthMiddleware");

// Public — look up which institutions have certs for a student ID (used to populate dropdown)
router.get("/lookup", studentController.lookupStudent);

// Public — authenticate with student ID + institution
router.post("/login", studentController.login);

// Protected — requires valid student JWT
router.get("/certificates", requireStudentAuth, studentController.getCertificates);
router.get("/profile", requireStudentAuth, studentController.getProfile);
router.post("/change-passphrase", requireStudentAuth, studentController.changePassphrase);

module.exports = router;
