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
const MONGODB_RETRY_DELAY_MS = Math.max(
  1000,
  parseInt(process.env.MONGODB_RETRY_DELAY_MS || "5000", 10) || 5000
);
let mongoConnectPromise = null;
let mongoRetryTimer = null;

function mongoStateLabel() {
  switch (mongoose.connection.readyState) {
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnecting";
    default:
      return "disconnected";
  }
}

async function connectMongo() {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  if (mongoConnectPromise) return mongoConnectPromise;

  mongoConnectPromise = mongoose
    .connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    })
    .then(() => {
      console.log("✅ MongoDB connected:", MONGODB_URI);
    })
    .catch((err) => {
      console.warn("⚠️  MongoDB connection failed:", err.message);
      scheduleMongoReconnect("initial connection failure");
    })
    .finally(() => {
      mongoConnectPromise = null;
    });

  return mongoConnectPromise;
}

function scheduleMongoReconnect(reason) {
  if (mongoRetryTimer) return;
  console.warn(`⚠️  Scheduling MongoDB reconnect in ${MONGODB_RETRY_DELAY_MS}ms (${reason}).`);
  mongoRetryTimer = setTimeout(() => {
    mongoRetryTimer = null;
    void connectMongo();
  }, MONGODB_RETRY_DELAY_MS);
}

mongoose.connection.on("disconnected", () => {
  scheduleMongoReconnect("connection dropped");
});

mongoose.connection.on("error", (err) => {
  console.warn("⚠️  MongoDB connection error:", err.message);
  scheduleMongoReconnect("connection error");
});

void connectMongo();

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

module.exports = app;
