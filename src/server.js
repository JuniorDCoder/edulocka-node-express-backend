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
const { ethers } = require("ethers");

const { connectMongo, mongoStateLabel } = require("./db/mongo");
const {
  ensureDirSync,
  getUploadsDir,
  getInstitutionDocsDir,
  getOutputDir,
  getCertificatesOutputDir,
  getQRCodesOutputDir,
  getExportsOutputDir,
  isServerlessRuntime,
} = require("./utils/runtimePaths");

const apiRoutes = require("./routes/api");
const institutionRoutes = require("./routes/institution");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = process.env.PORT || 4000;

// ── Ensure directories exist ────────────────────────────────────────────────
const dirs = [
  getUploadsDir(),
  getInstitutionDocsDir(),
  getOutputDir(),
  getCertificatesOutputDir(),
  getQRCodesOutputDir(),
  getExportsOutputDir(),
];
dirs.forEach((dir) => {
  if (!fs.existsSync(dir)) ensureDirSync(dir);
});

// ── MongoDB Connection ──────────────────────────────────────────────────────
void connectMongo().catch(() => {
  // Keep process alive; routes may attempt re-connect per request.
});

const allowedOrigins = [
  "https://edulocka.vercel.app",
  "https://www.edulocka.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  process.env.FRONTEND_URL,
].filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "x-wallet-address",
    "x-wallet-signature",
    "x-wallet-message",
  ],
  optionsSuccessStatus: 204,
};

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
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
  express.static(getOutputDir(), {
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
  res.json({
    status: "ok",
    db: mongoStateLabel(),
    timestamp: new Date().toISOString(),
  });
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
if (!isServerlessRuntime() && require.main === module) {
  app.listen(PORT, () => {
  let signerAddress = null;
  try {
    if (process.env.PRIVATE_KEY) {
      signerAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
    }
  } catch {
    // Ignore invalid key formatting here; runtime tx calls will report exact error.
  }

  console.log(`\n🎓 Edulocka Backend running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`   Frontend:    ${process.env.FRONTEND_URL}`);
  console.log(`   RPC:         ${process.env.RPC_URL}`);
  if (signerAddress) {
    console.log(`   Signer:      ${signerAddress}`);
  }

  const adminWallet = (process.env.ADMIN_WALLET_ADDRESS || "").toLowerCase();
  if (adminWallet && signerAddress && adminWallet !== signerAddress.toLowerCase()) {
    console.warn("⚠️  ADMIN_WALLET_ADDRESS does not match PRIVATE_KEY signer. Admin approvals may fail on-chain.");
  }

  console.log("");
  });
}

module.exports = app;
