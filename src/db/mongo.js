const mongoose = require("mongoose");

const DEFAULT_URI = "mongodb://localhost:27017/edulocka";
const SERVER_SELECTION_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || "10000", 10) || 10000
);

let connectPromise = null;
let mongoRetryDisabled = false;
let lastError = null;

function mongoStateLabel() {
  if (mongoRetryDisabled) return "auth_failed";
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

function isPermanentMongoError(err) {
  const message = String(err?.message || "").toLowerCase();
  const name = String(err?.name || "").toLowerCase();
  const code = Number(err?.code);

  return (
    code === 18 ||
    name.includes("mongoauthenticationerror") ||
    message.includes("authentication failed") ||
    message.includes("bad auth") ||
    message.includes("auth failed")
  );
}

function redactMongoUri(uri) {
  const value = String(uri || "");
  if (!value) return "";
  // Replace ":password@" after scheme://username:password@
  return value.replace(/(mongodb(?:\+srv)?:\/\/[^:/?#]+:)([^@]+)(@)/i, "$1***$3");
}

function getMongoUri() {
  return process.env.MONGODB_URI || DEFAULT_URI;
}

async function connectMongo() {
  if (mongoRetryDisabled) return;
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  if (connectPromise) return connectPromise;

  const uri = getMongoUri();
  const safeUri = redactMongoUri(uri);

  connectPromise = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    })
    .then(() => {
      lastError = null;
      if (process.env.NODE_ENV !== "test") {
        console.log("✅ MongoDB connected:", safeUri);
      }
    })
    .catch((err) => {
      lastError = err;
      console.warn("⚠️  MongoDB connection failed:", err.message);
      if (isPermanentMongoError(err)) {
        mongoRetryDisabled = true;
        console.error("❌ MongoDB authentication failed. Fix MONGODB_URI and redeploy/restart.");
        return;
      }
      throw err;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

async function ensureMongoConnected(timeoutMs = 9000) {
  if (mongoRetryDisabled) return false;
  if (mongoose.connection.readyState === 1) return true;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await connectMongo();
    } catch {
      // ignore; we'll re-check readyState and retry a few times within timeout
    }
    if (mongoose.connection.readyState === 1) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return mongoose.connection.readyState === 1;
}

function getLastMongoErrorMessage() {
  if (!lastError) return "";
  return String(lastError.message || "");
}

module.exports = {
  mongoStateLabel,
  redactMongoUri,
  getMongoUri,
  connectMongo,
  ensureMongoConnected,
  getLastMongoErrorMessage,
};

