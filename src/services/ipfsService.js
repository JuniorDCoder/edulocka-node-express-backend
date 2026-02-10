// ============================================================================
// IPFS Service — Upload files to Pinata (free tier)
// ============================================================================
// Pinata free tier: 500 uploads/month, 1GB storage
// Falls back to SHA-256 content hash if Pinata is not configured

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud";

function isPinataConfigured() {
  return (
    PINATA_JWT &&
    PINATA_JWT !== "your_pinata_jwt_token_here" &&
    PINATA_JWT.length > 50
  );
}

// ── Upload a file buffer to IPFS via Pinata ─────────────────────────────────

async function uploadBuffer(buffer, fileName, metadata = {}) {
  if (!isPinataConfigured()) {
    // Fallback: SHA-256 content hash (acts as a unique identifier)
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const cidHash = "Qm" + hash.slice(0, 44);
    return {
      ipfsHash: cidHash,
      pinned: false,
      gateway: null,
      message: "Pinata not configured — using local content hash",
    };
  }

  // Dynamic import for node-fetch if needed (Node 18+ has global fetch)
  const formData = new FormData();
  const blob = new Blob([buffer]);
  formData.append("file", blob, fileName);

  const pinataMetadata = JSON.stringify({
    name: fileName,
    keyvalues: metadata,
  });
  formData.append("pinataMetadata", pinataMetadata);

  const pinataOptions = JSON.stringify({ cidVersion: 1 });
  formData.append("pinataOptions", pinataOptions);

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Pinata upload failed (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  return {
    ipfsHash: data.IpfsHash,
    pinned: true,
    gateway: `${PINATA_GATEWAY}/ipfs/${data.IpfsHash}`,
    pinSize: data.PinSize,
  };
}

// ── Upload a file from disk ─────────────────────────────────────────────────

async function uploadFile(filePath, metadata = {}) {
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  return uploadBuffer(buffer, fileName, metadata);
}

// ── Upload JSON data ────────────────────────────────────────────────────────

async function uploadJSON(jsonData, name = "metadata.json") {
  if (!isPinataConfigured()) {
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(jsonData))
      .digest("hex");
    return {
      ipfsHash: "Qm" + hash.slice(0, 44),
      pinned: false,
      gateway: null,
    };
  }

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: JSON.stringify({
      pinataContent: jsonData,
      pinataMetadata: { name },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Pinata JSON upload failed (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  return {
    ipfsHash: data.IpfsHash,
    pinned: true,
    gateway: `${PINATA_GATEWAY}/ipfs/${data.IpfsHash}`,
  };
}

// ── Get gateway URL for a hash ──────────────────────────────────────────────

function getGatewayUrl(ipfsHash) {
  return `${PINATA_GATEWAY}/ipfs/${ipfsHash}`;
}

module.exports = {
  uploadBuffer,
  uploadFile,
  uploadJSON,
  getGatewayUrl,
  isPinataConfigured,
};
