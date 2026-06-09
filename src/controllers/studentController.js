const Certificate = require("../models/Certificate");
const { signStudentToken } = require("../middleware/studentAuthMiddleware");

// POST /api/student/login
// Body: { studentId, institutionName? }
async function login(req, res) {
  try {
    const { studentId, institutionName } = req.body;

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

    // Build institution list from found certs
    const institutionMap = {};
    for (const cert of certificates) {
      if (!institutionMap[cert.institution]) {
        institutionMap[cert.institution] = { name: cert.institution, count: 0 };
      }
      institutionMap[cert.institution].count += 1;
    }

    const institutions = Object.values(institutionMap);
    const studentName = certificates[0].studentName;

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
        totalCertificates: certificates.length,
      },
    });
  } catch (err) {
    console.error("Student login error:", err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/student/certificates
// Requires student JWT. Returns all issued certificates for this student.
async function getCertificates(req, res) {
  try {
    const { studentId, institutions } = req.student;
    const query = { studentId: { $regex: new RegExp(`^${escapeRegex(studentId)}$`, "i") } };

    // Optionally filter by institution if provided as query param
    const { institution, status } = req.query;
    if (institution) {
      query.institution = { $regex: new RegExp(escapeRegex(String(institution).trim()), "i") };
    } else if (institutions && institutions.length > 0) {
      // Scope to only the institutions the student has certs at
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
// Returns student identity derived from their certificates.
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

// Helper: escape special regex chars
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/student/lookup?studentId=xxx
// Public — validates a student ID and returns the institutions that have issued
// certificates to it. Used to populate the institution dropdown on the login page
// so students can only select an institution that has actually issued to them.
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

    return res.json({
      found: true,
      studentId: normalizedId,
      studentName: certs[0].studentName,
      institutions,
      total: certs.reduce((sum, _) => sum + 1, 0),
    });
  } catch (err) {
    console.error("Student lookupStudent error:", err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { login, lookupStudent, getCertificates, getProfile };
