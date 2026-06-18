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
const { ensureDbConnected } = require("./middleware/dbMiddleware");
let swaggerUi = null;
let buildOpenApiSpec = null;
try {
  // Optional at runtime: docs should never break core API.
  // Install: npm i swagger-ui-express swagger-jsdoc
  // eslint-disable-next-line global-require
  swaggerUi = require("swagger-ui-express");
  // eslint-disable-next-line global-require
  ({ buildOpenApiSpec } = require("./docs/openapi"));
} catch (err) {
  if (process.env.NODE_ENV !== "test") {
    console.warn("⚠️  API docs disabled (missing swagger dependencies):", err.message);
  }
}
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
const studentRoutes = require("./routes/student");
const mfaRoutes = require("./routes/mfa");

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
app.use("/api", ensureDbConnected);

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
app.use("/api/student", studentRoutes);
app.use("/api/student/mfa", mfaRoutes);

// ── API Docs ────────────────────────────────────────────────────────────────
if (swaggerUi && buildOpenApiSpec) {
  const openApiSpec = buildOpenApiSpec();
  app.get("/docs.json", (_req, res) => res.json(openApiSpec));
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: "Edulocka API Docs",
      customCss: `
        .swagger-ui .topbar { background: #0b1220; }
        .swagger-ui .topbar a { color: #e5e7eb; }
        .swagger-ui .scheme-container { background: #f9fafb; }
        .swagger-ui .btn.authorize { background-color: #111827; border-color: #111827; }
      `,
    })
  );
} else {
  app.get("/docs.json", (_req, res) =>
    res.status(503).json({ error: "API docs disabled. Install swagger dependencies." })
  );
  app.get("/docs", (_req, res) =>
    res
      .status(503)
      .type("html")
      .send(
        "<h2>API docs disabled</h2><p>Install <code>swagger-ui-express</code> and <code>swagger-jsdoc</code> then redeploy.</p>"
      )
  );
}

// ── Landing Page ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const host = String(req.headers.host || "localhost");
  const proto = String(req.headers["x-forwarded-proto"] || "http");
  const baseUrl = `${proto}://${host}`;
  res.status(200).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Edulocka API</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: radial-gradient(1200px 800px at 20% 0%, #eef2ff, #ffffff 55%); color: #0f172a; }
      .wrap { max-width: 980px; margin: 0 auto; padding: 56px 20px; }
      .pill { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 10px; border-radius: 999px; background: #0b1220; color: #e5e7eb; }
      .card { background: rgba(255,255,255,0.86); border: 1px solid #e5e7eb; border-radius: 18px; padding: 28px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); backdrop-filter: blur(6px); }
      h1 { margin: 0 0 10px; font-size: 34px; letter-spacing: -0.02em; }
      p { margin: 0 0 18px; line-height: 1.55; color: #334155; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 18px; }
      @media (min-width: 860px) { .grid { grid-template-columns: 1.1fr 0.9fr; } }
      a.btn { display: inline-flex; align-items: center; justify-content: center; gap: 10px; padding: 12px 14px; border-radius: 12px; text-decoration: none; font-weight: 600; border: 1px solid #111827; background: #111827; color: #ffffff; }
      a.btn.secondary { background: transparent; color: #111827; }
      code { background: #f1f5f9; border: 1px solid #e2e8f0; padding: 2px 6px; border-radius: 8px; }
      ul { margin: 0; padding-left: 18px; color: #334155; }
      li { margin: 8px 0; }
      .muted { color: #64748b; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="pill">Edulocka Backend</div>
      <div style="height:12px"></div>
      <div class="card">
        <h1>Edulocka API</h1>
        <p>Interactive documentation, request samples, and schemas.</p>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin: 16px 0 10px;">
          <a class="btn" href="/docs">Open API Docs</a>
          <a class="btn secondary" href="/health">Health Check</a>
          <a class="btn secondary" href="/docs.json">OpenAPI JSON</a>
        </div>
        <div class="grid">
          <div>
            <p class="muted">Quick endpoints</p>
            <ul>
              <li><code>GET</code> <code>${baseUrl}/api/blogs</code></li>
              <li><code>GET</code> <code>${baseUrl}/api/templates</code></li>
              <li><code>POST</code> <code>${baseUrl}/api/certificates/issue</code></li>
              <li><code>GET</code> <code>${baseUrl}/api/certificates/verify/:certId</code></li>
            </ul>
          </div>
          <div>
            <p class="muted">Notes</p>
            <ul>
              <li>Some routes accept wallet headers like <code>x-wallet-address</code>.</li>
              <li>Admin routes require signed headers and the configured admin wallet.</li>
              <li>Set <code>PUBLIC_API_BASE_URL</code> in env to show the correct server in Swagger.</li>
            </ul>
          </div>
        </div>
      </div>
      <div style="height:14px"></div>
      <div class="muted">If you expected JSON, use <code>/health</code> or <code>/docs.json</code>.</div>
    </div>
  </body>
</html>`);
});

// Health check
/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     responses:
 *       200:
 *         description: Service status
 */
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
