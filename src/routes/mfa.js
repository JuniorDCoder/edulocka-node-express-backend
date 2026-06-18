const express = require("express");
const router = express.Router();
const mfaController = require("../controllers/mfaController");
const { requireStudentAuth } = require("../middleware/studentAuthMiddleware");

// Public — used during login flow
router.post("/challenge", mfaController.challenge);
router.post("/login-verify", mfaController.loginVerify);

// Protected — requires valid student JWT
router.get("/status", requireStudentAuth, mfaController.getStatus);
router.post("/setup/authenticator", requireStudentAuth, mfaController.setupAuthenticator);
router.post("/verify/authenticator", requireStudentAuth, mfaController.verifyAuthenticator);
router.post("/setup/pin", requireStudentAuth, mfaController.setupPin);
router.post("/setup/email", requireStudentAuth, mfaController.setupEmail);
router.post("/verify/email", requireStudentAuth, mfaController.verifyEmail);
router.post("/disable", requireStudentAuth, mfaController.disable);

module.exports = router;
