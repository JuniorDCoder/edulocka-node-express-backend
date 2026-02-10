// ============================================================================
// Admin Middleware — Protects admin-only routes
// ============================================================================
// Only the Edulocka admin wallet (contract owner) can access admin routes.
// Uses wallet-based auth (Web3-native: sign a message to prove ownership).

const { ethers } = require("ethers");
const { verifyWalletSignature } = require("./authMiddleware");

// The admin wallet address — set via environment variable
const ADMIN_WALLET_ADDRESS = (process.env.ADMIN_WALLET_ADDRESS || "").toLowerCase();

/**
 * Check if a wallet address is the Edulocka admin.
 * @param {string} address - Wallet address to check
 * @returns {boolean}
 */
function isAdminWallet(address) {
  if (!ADMIN_WALLET_ADDRESS) {
    console.warn("⚠️  ADMIN_WALLET_ADDRESS not set in environment!");
    return false;
  }
  return address.toLowerCase() === ADMIN_WALLET_ADDRESS;
}

/**
 * Express middleware: Requires admin wallet authentication.
 *
 * Expected headers (same as requireWalletAuth):
 *   x-wallet-address: "0x..."
 *   x-wallet-signature: "0x..."
 *   x-wallet-message: "Edulocka Admin: <timestamp>"
 *
 * Additionally checks that the wallet address matches ADMIN_WALLET_ADDRESS.
 */
function requireAdminAuth(req, res, next) {
  const address = req.headers["x-wallet-address"];
  const signature = req.headers["x-wallet-signature"];
  const message = req.headers["x-wallet-message"];

  if (!address || !signature || !message) {
    return res.status(401).json({
      error: "Admin authentication required",
      details: "Missing admin authentication headers",
    });
  }

  if (!ethers.isAddress(address)) {
    return res.status(401).json({ error: "Invalid wallet address format" });
  }

  // Check if this is the admin wallet
  if (!isAdminWallet(address)) {
    return res.status(403).json({
      error: "Access denied",
      details: "Only the Edulocka admin wallet can access this endpoint",
    });
  }

  // Verify message freshness (5 minute window)
  const timestampMatch = message.match(/Edulocka (?:Admin|Auth): (\d+)/);
  if (!timestampMatch) {
    return res.status(401).json({
      error: "Invalid auth message format. Expected: 'Edulocka Admin: <timestamp>'",
    });
  }

  const messageTimestamp = parseInt(timestampMatch[1], 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - messageTimestamp) > 5 * 60) {
    return res.status(401).json({ error: "Auth message expired. Please sign a fresh message." });
  }

  // Verify the signature
  if (!verifyWalletSignature(signature, message, address)) {
    return res.status(401).json({ error: "Invalid admin signature" });
  }

  req.adminAddress = address.toLowerCase();
  next();
}

module.exports = {
  isAdminWallet,
  requireAdminAuth,
};
