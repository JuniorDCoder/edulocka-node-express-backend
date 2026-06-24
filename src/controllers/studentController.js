const Certificate = require("../models/Certificate");
const StudentMFA = require("../models/StudentMFA");
const StudentAccount = require("../models/StudentAccount");
const { signStudentToken } = require("../middleware/studentAuthMiddleware");

// POST /api/student/login
// Body: { studentId, institutionName?, passphrase? }
async function login(req, res) {
  try {
    const { studentId, institutionName, passphrase } = req.body;

    if (!studentId || !String(studentId).trim()) {
      return res.status(400).json({ error: "studentId is required" });
    }

    const normalizedId = String(studentId).trim();
    const query = { studentId: { $regex: new RegExp(`^${escapeRegex(normalizedId)}$`, "i") } };

    if (institutionName) {
      query.institution = { $regex: new RegExp(escapeRegex(String(institutionName).trim()), "i") };
    }

    const certificates = await Certificate.find(query).sort({ createdAt: -1 }).lean();

    if (certificates.length === 0) {
      return res.status(404).json({
        error: "No certificates found for this Student ID. Please check your ID or contact your institution.",
      });
    }

    const institutionMap = {};
    for (const cert of certificates) {
      if (!institutionMap[cert.institution]) {
        institutionMap[cert.institution] = { name: cert.institution, count: 0 };
      }
      institutionMap[cert.institution].count += 1;
    }

    const institutions = Object.values(institutionMap);
    const studentName = certificates[0].studentName;

    // Check if this student has a passphrase set
    const account = await StudentAccount.findOne({
      studentId: { $regex: new RegExp(`^${escapeRegex(normalizedId)}$`, "i") },
    });

    if (account) {
      // Account exists — passphrase is required
      if (!passphrase) {
        return res.json({
          success: true,
          passphraseRequired: true,
          hasAccount: true,
          student: {
            studentId: normalizedId,
            studentName,
            institutions,
            totalCertificates: certificates.length,
          },
        });
      }

      if (!account.verifyPassphrase(String(passphrase))) {
        return res.status(401).json({ error: "Incorrect passphrase." });
      }
    } else {
      // No account — prompt to create a passphrase
      if (!passphrase) {
        return res.json({
          success: true,
          passphraseRequired: true,
          hasAccount: false,
          student: {
            studentId: normalizedId,
            studentName,
            institutions,
            totalCertificates: certificates.length,
          },
        });
      }

      // Creating new passphrase
      if (String(passphrase).length < 6) {
        return res.status(400).json({ error: "Passphrase must be at least 6 characters." });
      }

      const { hash, salt } = StudentAccount.hashPassphrase(String(passphrase));
      await StudentAccount.create({
        studentId: normalizedId,
        passphraseHash: hash,
        salt,
      });
    }

    // Passphrase verified or just created — check MFA
    const selectedInstitution = institutionName || institutions[0]?.name;
    if (selectedInstitution) {
      const mfa = await StudentMFA.findOne({
        studentId: { $regex: new RegExp(`^${escapeRegex(normalizedId)}$`, "i") },
        institution: { $regex: new RegExp(escapeRegex(String(selectedInstitution).trim()), "i") },
        mfaEnabled: true,
      }).lean();

      if (mfa) {
        return res.json({
          success: true,
          mfaRequired: true,
          mfaMethod: mfa.mfaMethod,
          student: {
            studentId: normalizedId,
            studentName,
            institutions,
            totalCertificates: certificates.length,
          },
        });
      }
    }

    const token = signStudentToken({
      studentId: normalizedId,
      studentName,
      institutions: institutions.map((i) => i.name),
    });

    return res.json({
      success: true,
      mfaRequired: false,
      token,
      student: {
        studentId: normalizedId,
        studentName,
        institutions,
        totalCertificates: certificates.length,
      },
    });
  } catch (err) {
    console.error("Student login error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/student/change-passphrase
async function changePassphrase(req, res) {
  try {
    const { studentId } = req.student;
    const { currentPassphrase, newPassphrase } = req.body;

    if (!currentPassphrase || !newPassphrase) {
      return res.status(400).json({ error: "Current and new passphrase are required." });
    }

    if (String(newPassphrase).length < 6) {
      return res.status(400).json({ error: "New passphrase must be at least 6 characters." });
    }

    const account = await StudentAccount.findOne({
      studentId: { $regex: new RegExp(`^${escapeRegex(studentId)}$`, "i") },
    });

    if (!account) {
      return res.status(400).json({ error: "No account found." });
    }

    if (!account.verifyPassphrase(String(currentPassphrase))) {
      return res.status(401).json({ error: "Current passphrase is incorrect." });
    }

    const { hash, salt } = StudentAccount.hashPassphrase(String(newPassphrase));
    account.passphraseHash = hash;
    account.salt = salt;
    await account.save();

    res.json({ success: true, message: "Passphrase updated." });
  } catch (err) {
    console.error("Student changePassphrase error:", err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/student/certificates
async function getCertificates(req, res) {
  try {
    const { studentId, institutions } = req.student;
    const query = { studentId: { $regex: new RegExp(`^${escapeRegex(studentId)}$`, "i") } };

    const { institution, status } = req.query;
    if (institution) {
      query.institution = { $regex: new RegExp(escapeRegex(String(institution).trim()), "i") };
    } else if (institutions && institutions.length > 0) {
      query.institution = { $in: institutions };
    }

    if (status === "issued" || status === "revoked") {
      query.status = status;
    }

    const certificates = await Certificate.find(query).sort({ createdAt: -1 }).lean();

    const formatted = certificates.map((c) => ({
      certId: c.certId,
      studentName: c.studentName,
      studentId: c.studentId,
      degree: c.degree,
      institution: c.institution,
      issueDate: c.issueDate,
      status: c.status,
      blockchain: {
        txHash: c.blockchain?.txHash || null,
        blockNumber: c.blockchain?.blockNumber || null,
        issuedAt: c.blockchain?.issuedAt || null,
      },
      ipfs: {
        ipfsHash: c.ipfs?.ipfsHash || null,
        documentHash: c.ipfs?.documentHash || null,
        gateway: c.ipfs?.gateway || null,
      },
      revokedAt: c.revokedAt || null,
      createdAt: c.createdAt,
    }));

    res.json({ certificates: formatted, total: formatted.length });
  } catch (err) {
    console.error("Student getCertificates error:", err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/student/profile
async function getProfile(req, res) {
  try {
    const { studentId, studentName, institutions } = req.student;

    const query = {
      studentId: { $regex: new RegExp(`^${escapeRegex(studentId)}$`, "i") },
    };

    const [total, issued, revoked] = await Promise.all([
      Certificate.countDocuments(query),
      Certificate.countDocuments({ ...query, status: "issued" }),
      Certificate.countDocuments({ ...query, status: "revoked" }),
    ]);

    res.json({
      studentId,
      studentName,
      institutions,
      stats: { total, issued, revoked },
    });
  } catch (err) {
    console.error("Student getProfile error:", err);
    res.status(500).json({ error: err.message });
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/student/lookup?studentId=xxx
async function lookupStudent(req, res) {
  try {
    const { studentId } = req.query;
    if (!studentId || !String(studentId).trim()) {
      return res.status(400).json({ error: "studentId is required" });
    }

    const normalizedId = String(studentId).trim();
    const certs = await Certificate.find({
      studentId: { $regex: new RegExp(`^${escapeRegex(normalizedId)}$`, "i") },
    })
      .select("institution studentName")
      .lean();

    if (certs.length === 0) {
      return res.status(404).json({
        error:
          "No certificates found for this Student ID. Please check your ID or contact your institution.",
      });
    }

    const institutionMap = {};
    for (const cert of certs) {
      if (!institutionMap[cert.institution]) {
        institutionMap[cert.institution] = { name: cert.institution, count: 0 };
      }
      institutionMap[cert.institution].count += 1;
    }

    const institutions = Object.values(institutionMap).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    // Check if this student already has an account (passphrase set)
    const hasAccount = await StudentAccount.exists({
      studentId: { $regex: new RegExp(`^${escapeRegex(normalizedId)}$`, "i") },
    });

    return res.json({
      found: true,
      studentId: normalizedId,
      studentName: certs[0].studentName,
      institutions,
      total: certs.reduce((sum, _) => sum + 1, 0),
      hasAccount: !!hasAccount,
    });
  } catch (err) {
    console.error("Student lookupStudent error:", err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { login, lookupStudent, getCertificates, getProfile, changePassphrase };
