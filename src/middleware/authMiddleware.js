// ============================================================================
// Auth Middleware — Wallet-based authentication for institutions
// ============================================================================
// Verifies that the caller owns the wallet they claim to by checking a signed
// message. This is the Web3-native way to authenticate — no passwords needed.

const { ethers } = require("ethers");

/**
 * Verify a wallet signature against a message and expected address.
 * Used to prove wallet ownership without exposing private keys.
 *
 * @param {string} signature - The signature produced by wallet.signMessage()
 * @param {string} message - The original message that was signed
 * @param {string} expectedAddress - The address that should have signed
 * @returns {boolean} True if the signature is valid for the given address
 */
function verifyWalletSignature(signature, message, expectedAddress) {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Express middleware: Requires a valid wallet signature in request headers.
 *
 * Expected headers:
 *   x-wallet-address: "0x..."
 *   x-wallet-signature: "0x..."
 *   x-wallet-message: "Edulocka Auth: <timestamp>"
 *
 * The message must be recent (within 5 minutes) to prevent replay attacks.
 */
function requireWalletAuth(req, res, next) {
  const address = req.headers["x-wallet-address"];
  const signature = req.headers["x-wallet-signature"];
  const message = req.headers["x-wallet-message"];

  if (!address || !signature || !message) {
    return res.status(401).json({
      error: "Authentication required",
      details: "Missing wallet authentication headers (x-wallet-address, x-wallet-signature, x-wallet-message)",
    });
  }

  // Validate address format
  if (!ethers.isAddress(address)) {
    return res.status(401).json({ error: "Invalid wallet address format" });
  }

  // Verify message freshness (within 5 minutes to prevent replay attacks)
  const timestampMatch = message.match(/Edulocka Auth: (\d+)/);
  if (!timestampMatch) {
    return res.status(401).json({ error: "Invalid auth message format. Expected: 'Edulocka Auth: <timestamp>'" });
  }

  const messageTimestamp = parseInt(timestampMatch[1], 10);
  const now = Math.floor(Date.now() / 1000);
  const MAX_AGE_SECONDS = 5 * 60; // 5 minutes

  if (Math.abs(now - messageTimestamp) > MAX_AGE_SECONDS) {
    return res.status(401).json({ error: "Auth message expired. Please sign a fresh message." });
  }

  // Verify signature
  if (!verifyWalletSignature(signature, message, address)) {
    return res.status(401).json({ error: "Invalid wallet signature" });
  }

  // Attach verified address to request
  req.walletAddress = address.toLowerCase();
  next();
}

/**
 * Rate limiting middleware per wallet address.
 * Prevents a single institution from spamming the API.
 *
 * @param {number} maxRequests - Max requests per time window
 * @param {number} windowMs - Time window in milliseconds
 */
function walletRateLimit(maxRequests = 50, windowMs = 15 * 60 * 1000) {
  const requests = new Map(); // address -> { count, resetTime }

  return (req, res, next) => {
    const address = req.walletAddress || req.headers["x-wallet-address"] || "unknown";
    const now = Date.now();
    const entry = requests.get(address);

    if (!entry || now > entry.resetTime) {
      requests.set(address, { count: 1, resetTime: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: Math.ceil((entry.resetTime - now) / 1000),
      });
    }

    entry.count++;
    next();
  };
}

/**
 * Optional wallet auth middleware.
 * If valid auth headers are present, attaches walletAddress to req.
 * If not, continues without error (walletAddress will be undefined).
 * Useful for routes that behave differently for authenticated vs anonymous users.
 */
function optionalWalletAuth(req, res, next) {
  const address = req.headers["x-wallet-address"];
  const signature = req.headers["x-wallet-signature"];
  const message = req.headers["x-wallet-message"];

  // If no address at all, just continue
  if (!address) {
    return next();
  }

  // Validate address format
  if (!ethers.isAddress(address)) {
    return next(); // Skip auth silently
  }

  // If full auth headers are present, verify signature
  if (signature && message) {
    const timestampMatch = message.match(/Edulocka Auth: (\d+)/);
    if (timestampMatch) {
      const messageTimestamp = parseInt(timestampMatch[1], 10);
      const now = Math.floor(Date.now() / 1000);
      const MAX_AGE_SECONDS = 5 * 60;

      if (
        Math.abs(now - messageTimestamp) <= MAX_AGE_SECONDS &&
        verifyWalletSignature(signature, message, address)
      ) {
        req.walletAddress = address.toLowerCase();
        return next();
      }
    }
  }

  // For GET (read-only) requests, accept address alone without signature.
  // This lets template listing work without a MetaMask signing popup.
  if (req.method === "GET") {
    req.walletAddress = address.toLowerCase();
  }

  next();
}

module.exports = {
  verifyWalletSignature,
  requireWalletAuth,
  optionalWalletAuth,
  walletRateLimit,
};
