const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.STUDENT_JWT_SECRET || process.env.JWT_SECRET || "edulocka-student-secret-change-in-production";
const TOKEN_EXPIRY = "7d";

function signStudentToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function verifyStudentToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireStudentAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Student authentication required. Provide Authorization: Bearer <token>" });
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyStudentToken(token);
    req.student = {
      studentId: payload.studentId,
      studentName: payload.studentName,
      institutions: payload.institutions || [],
    };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }
    return res.status(401).json({ error: "Invalid student token." });
  }
}

module.exports = { signStudentToken, verifyStudentToken, requireStudentAuth };
