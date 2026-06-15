// ============================================================================
// DB Middleware — Ensure MongoDB is connected before handling API requests
// ============================================================================
// In serverless environments, the connection kicked off at module load may
// still be pending when the first request(s) arrive. Mongoose buffers queries
// for up to 10s by default, which surfaces as a slow/failed response. This
// middleware waits for the connection (bounded) before proceeding.

const mongoose = require("mongoose");
const { ensureMongoConnected, mongoStateLabel, getLastMongoErrorMessage } = require("../db/mongo");

async function ensureDbConnected(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();

  const ok = await ensureMongoConnected(8000);
  if (ok) return next();

  res.status(503).json({
    error: "Database temporarily unavailable. Please try again in a few seconds.",
    db: mongoStateLabel(),
    ...(process.env.NODE_ENV === "development" && { details: getLastMongoErrorMessage() }),
  });
}

module.exports = { ensureDbConnected };
