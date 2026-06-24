const crypto = require("crypto");
const OTPAuth = require("otpauth");
const StudentMFA = require("../models/StudentMFA");
const Certificate = require("../models/Certificate");
const { signStudentToken } = require("../middleware/studentAuthMiddleware");
const { sendMfaCodeEmail, isEmailConfigured } = require("../services/emailService");

function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// GET /api/student/mfa/status
async function getStatus(req, res) {
  try {
    const { studentId, institutions } = req.student;
    const institution = institutions[0] || "";

    const [mfa, certWithEmail] = await Promise.all([
      StudentMFA.findOne({ studentId, institution }).lean(),
      Certificate.findOne({
        studentId: { $regex: new RegExp(`^${escapeRegex(studentId)}$`, "i") },
        institution: { $regex: new RegExp(escapeRegex(institution), "i") },
        studentEmail: { $ne: null, $exists: true },
      }).select("studentEmail").lean(),
    ]);

    res.json({
      mfaEnabled: mfa?.mfaEnabled || false,
      mfaMethod: mfa?.mfaMethod || null,
      hasAuthenticator: !!(mfa?.totp?.secret && mfa?.totp?.verified),
      hasPin: !!mfa?.pin?.hash,
      hasEmail: !!mfa?.emailOtp?.email,
      email: mfa?.emailOtp?.email ? maskEmail(mfa.emailOtp.email) : null,
      emailAvailable: !!certWithEmail?.studentEmail,
    });
  } catch (err) {
    console.error("MFA getStatus error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/setup/authenticator
async function setupAuthenticator(req, res) {
  try {
    const { studentId, institutions, studentName } = req.student;
    const institution = institutions[0] || "";

    const secretHex = crypto.randomBytes(20).toString("hex");
    const totp = new OTPAuth.TOTP({
      issuer: `Edulocka (${institution})`,
      label: studentId,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromHex(secretHex),
    });
    const secret = totp.secret.base32;
    const otpauth = totp.toString();

    let mfa = await StudentMFA.findOne({ studentId, institution });
    if (!mfa) {
      mfa = new StudentMFA({ studentId, institution });
    }

    mfa.totp = { secret, verified: false };
    await mfa.save();

    res.json({
      success: true,
      secret,
      otpauthUrl: otpauth,
      message: "Scan the QR code with your authenticator app, then verify with a code.",
    });
  } catch (err) {
    console.error("MFA setupAuthenticator error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/verify/authenticator
async function verifyAuthenticator(req, res) {
  try {
    const { studentId, institutions } = req.student;
    const institution = institutions[0] || "";
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Verification code is required." });
    }

    const mfa = await StudentMFA.findOne({ studentId, institution });
    if (!mfa?.totp?.secret) {
      return res.status(400).json({ error: "Authenticator not set up. Please set it up first." });
    }

    const totp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(mfa.totp.secret),
    });
    const isValid = totp.validate({ token: String(code).replace(/\s/g, ""), window: 1 }) !== null;

    if (!isValid) {
      return res.status(400).json({ error: "Invalid code. Please try again." });
    }

    mfa.totp.verified = true;
    mfa.mfaEnabled = true;
    mfa.mfaMethod = "authenticator";
    await mfa.save();

    res.json({ success: true, message: "Authenticator verified and MFA enabled." });
  } catch (err) {
    console.error("MFA verifyAuthenticator error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/setup/pin
async function setupPin(req, res) {
  try {
    const { studentId, institutions } = req.student;
    const institution = institutions[0] || "";
    const { pin } = req.body;

    if (!pin || !/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({ error: "PIN must be 4-6 digits." });
    }

    let mfa = await StudentMFA.findOne({ studentId, institution });
    if (!mfa) {
      mfa = new StudentMFA({ studentId, institution });
    }

    mfa.pin = { hash: hashPin(pin) };
    mfa.mfaEnabled = true;
    mfa.mfaMethod = "pin";
    await mfa.save();

    res.json({ success: true, message: "PIN set and MFA enabled." });
  } catch (err) {
    console.error("MFA setupPin error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/setup/email
// Uses the email set by the institution when issuing the certificate — students cannot choose an arbitrary email.
async function setupEmail(req, res) {
  try {
    const { studentId, institutions, studentName } = req.student;
    const institution = institutions[0] || "";

    if (!isEmailConfigured()) {
      return res.status(503).json({ error: "Email service is not configured on this server." });
    }

    const cert = await Certificate.findOne({
      studentId: { $regex: new RegExp(`^${escapeRegex(studentId)}$`, "i") },
      institution: { $regex: new RegExp(escapeRegex(institution), "i") },
      studentEmail: { $ne: null, $exists: true },
    }).select("studentEmail").sort({ createdAt: -1 }).lean();

    if (!cert?.studentEmail) {
      return res.status(400).json({
        error: "No email address is on file for your certificates. Your institution must include an email when issuing certificates for email MFA to be available.",
      });
    }

    const email = cert.studentEmail;
    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    let mfa = await StudentMFA.findOne({ studentId, institution });
    if (!mfa) {
      mfa = new StudentMFA({ studentId, institution });
    }

    mfa.emailOtp = { email, code, expiresAt };
    await mfa.save();

    await sendMfaCodeEmail({ to: email, code, studentName: req.student.studentName });

    res.json({
      success: true,
      emailHint: maskEmail(email),
      message: "Verification code sent to the email your institution has on file.",
    });
  } catch (err) {
    console.error("MFA setupEmail error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/verify/email
async function verifyEmail(req, res) {
  try {
    const { studentId, institutions } = req.student;
    const institution = institutions[0] || "";
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Verification code is required." });
    }

    const mfa = await StudentMFA.findOne({ studentId, institution });
    if (!mfa?.emailOtp?.email) {
      return res.status(400).json({ error: "Email OTP not set up. Please set it up first." });
    }

    if (mfa.emailOtp.code !== String(code).trim()) {
      return res.status(400).json({ error: "Invalid code. Please try again." });
    }

    if (new Date() > mfa.emailOtp.expiresAt) {
      return res.status(400).json({ error: "Code expired. Please request a new one." });
    }

    mfa.emailOtp.code = null;
    mfa.emailOtp.expiresAt = null;
    mfa.mfaEnabled = true;
    mfa.mfaMethod = "email";
    await mfa.save();

    res.json({ success: true, message: "Email verified and MFA enabled." });
  } catch (err) {
    console.error("MFA verifyEmail error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/disable
async function disable(req, res) {
  try {
    const { studentId, institutions } = req.student;
    const institution = institutions[0] || "";

    const mfa = await StudentMFA.findOne({ studentId, institution });
    if (!mfa) {
      return res.json({ success: true, message: "MFA is already disabled." });
    }

    mfa.mfaEnabled = false;
    mfa.mfaMethod = null;
    mfa.totp = { secret: null, verified: false };
    mfa.pin = { hash: null };
    mfa.emailOtp = { email: null, code: null, expiresAt: null };
    await mfa.save();

    res.json({ success: true, message: "MFA has been disabled." });
  } catch (err) {
    console.error("MFA disable error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/challenge
// Called during login when MFA is required. Expects { studentId, institutionName, method? }
// For email method, sends the OTP code.
async function challenge(req, res) {
  try {
    const { studentId, institutionName } = req.body;

    if (!studentId || !institutionName) {
      return res.status(400).json({ error: "studentId and institutionName are required." });
    }

    const mfa = await StudentMFA.findOne({
      studentId: { $regex: new RegExp(`^${escapeRegex(String(studentId).trim())}$`, "i") },
      institution: { $regex: new RegExp(escapeRegex(String(institutionName).trim()), "i") },
    });

    if (!mfa || !mfa.mfaEnabled) {
      return res.json({ mfaRequired: false });
    }

    const response = { mfaRequired: true, method: mfa.mfaMethod };

    if (mfa.mfaMethod === "email" && mfa.emailOtp?.email) {
      const code = generateOtpCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      mfa.emailOtp.code = code;
      mfa.emailOtp.expiresAt = expiresAt;
      await mfa.save();

      if (isEmailConfigured()) {
        const certs = await Certificate.find({
          studentId: { $regex: new RegExp(`^${escapeRegex(String(studentId).trim())}$`, "i") },
        }).select("studentName").limit(1).lean();
        const studentName = certs[0]?.studentName || "Student";

        await sendMfaCodeEmail({
          to: mfa.emailOtp.email,
          code,
          studentName,
        });
      }

      response.emailHint = maskEmail(mfa.emailOtp.email);
    }

    res.json(response);
  } catch (err) {
    console.error("MFA challenge error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/mfa/login-verify
// Verifies MFA code during login and returns JWT on success.
async function loginVerify(req, res) {
  try {
    const { studentId, institutionName, code } = req.body;

    if (!studentId || !institutionName || !code) {
      return res.status(400).json({ error: "studentId, institutionName, and code are required." });
    }

    const normalizedId = String(studentId).trim();
    const mfa = await StudentMFA.findOne({
      studentId: { $regex: new RegExp(`^${escapeRegex(normalizedId)}$`, "i") },
      institution: { $regex: new RegExp(escapeRegex(String(institutionName).trim()), "i") },
    });

    if (!mfa || !mfa.mfaEnabled) {
      return res.status(400).json({ error: "MFA is not enabled for this account." });
    }

    let verified = false;

    if (mfa.mfaMethod === "authenticator") {
      const totp = new OTPAuth.TOTP({
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(mfa.totp.secret),
      });
      verified = totp.validate({ token: String(code).replace(/\s/g, ""), window: 1 }) !== null;
    } else if (mfa.mfaMethod === "pin") {
      verified = hashPin(code) === mfa.pin.hash;
    } else if (mfa.mfaMethod === "email") {
      if (!mfa.emailOtp?.code) {
        return res.status(400).json({ error: "No email code was sent. Please request a new one." });
      }
      if (new Date() > mfa.emailOtp.expiresAt) {
        return res.status(400).json({ error: "Code expired. Please request a new one." });
      }
      verified = mfa.emailOtp.code === String(code).trim();
      if (verified) {
        mfa.emailOtp.code = null;
        mfa.emailOtp.expiresAt = null;
        await mfa.save();
      }
    }

    if (!verified) {
      return res.status(401).json({ error: "Invalid verification code." });
    }

    const certs = await Certificate.find({
      studentId: { $regex: new RegExp(`^${escapeRegex(normalizedId)}$`, "i") },
    }).sort({ createdAt: -1 }).lean();

    if (certs.length === 0) {
      return res.status(404).json({ error: "No certificates found." });
    }

    const institutionMap = {};
    for (const cert of certs) {
      if (!institutionMap[cert.institution]) {
        institutionMap[cert.institution] = { name: cert.institution, count: 0 };
      }
      institutionMap[cert.institution].count += 1;
    }

    const institutions = Object.values(institutionMap);
    const studentName = certs[0].studentName;

    const token = signStudentToken({
      studentId: normalizedId,
      studentName,
      institutions: institutions.map((i) => i.name),
    });

    return res.json({
      success: true,
      token,
      student: {
        studentId: normalizedId,
        studentName,
        institutions,
        totalCertificates: certs.length,
      },
    });
  } catch (err) {
    console.error("MFA loginVerify error:", err);
    res.status(500).json({ error: err.message });
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}***@${domain}`;
}

module.exports = {
  getStatus,
  setupAuthenticator,
  verifyAuthenticator,
  setupPin,
  setupEmail,
  verifyEmail,
  disable,
  challenge,
  loginVerify,
};
