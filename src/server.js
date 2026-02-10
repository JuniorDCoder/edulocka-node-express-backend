// ============================================================================
// Edulocka Backend — Express Server
// ============================================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const apiRoutes = require("./routes/api");
const institutionRoutes = require("./routes/institution");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = process.env.PORT || 4000;

// ── Ensure directories exist ────────────────────────────────────────────────
const dirs = [
  path.join(__dirname, "..", "uploads"),
  path.join(__dirname, "..", "uploads", "institution-docs"),
  path.join(__dirname, "..", "output"),
  path.join(__dirname, "..", "output", "certificates"),
  path.join(__dirname, "..", "output", "qrcodes"),
  path.join(__dirname, "..", "output", "exports"),
];
dirs.forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── MongoDB Connection ──────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/edulocka";
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected:", MONGODB_URI))
  .catch((err) => console.warn("⚠️  MongoDB not available:", err.message, "— institution features will be limited"));

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(morgan("dev"));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api", limiter);

// Serve generated files (PDFs, QR codes)
app.use(
  "/output",
  express.static(path.join(__dirname, "..", "output"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".pdf")) {
        res.setHeader("Content-Type", "application/pdf");
      }
    },
  })
);

// ── Routes ──────────────────────────────────────────────────────────────────
app.use("/api", apiRoutes);
app.use("/api/institution", institutionRoutes);
app.use("/api/admin", adminRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Error handler ───────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎓 Edulocka Backend running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`   Frontend:    ${process.env.FRONTEND_URL}`);
  console.log(`   RPC:         ${process.env.RPC_URL}\n`);
});

module.exports = app;
