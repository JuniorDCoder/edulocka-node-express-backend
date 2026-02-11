// ============================================================================
// Blockchain Service — Ethers.js interaction with CertificateRegistry
// ============================================================================
// Handles all on-chain operations: issuance, verification, batch transactions

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// Load ABI from the compiled Hardhat artifacts
const ARTIFACT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "smart-contracts",
  "artifacts",
  "contracts",
  "CertificateRegistry.sol",
  "CertificateRegistry.json"
);

let CONTRACT_ABI;
if (fs.existsSync(ARTIFACT_PATH)) {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
  CONTRACT_ABI = artifact.abi;
} else {
  // Fallback: human-readable ABI (same as frontend)
  CONTRACT_ABI = [
    "function getTotalCertificates() view returns (uint256)",
    "function totalInstitutions() view returns (uint256)",
    "function totalRevocations() view returns (uint256)",
    "function getAllCertificateIdsCount() view returns (uint256)",
    "function getCertificateIdByIndex(uint256 _index) view returns (string)",
    "function isAuthorizedInstitution(address _institution) view returns (bool)",
    "function isAuthorized(address) view returns (bool)",
    "function certificateExistsCheck(string _certificateId) view returns (bool)",
    "function owner() view returns (address)",
    "function maxDailyCertificates() view returns (uint256)",
    "function getCertificate(string _certificateId) view returns (tuple(string studentName, string studentId, string degree, string institution, uint256 issueDate, string ipfsHash, address issuer, bool isValid, bool exists))",
    "function verifyCertificate(string _certificateId) view returns (bool isValid, string studentName, string degree, string institution, uint256 issueDate, address issuer)",
    "function getInstitution(address _institution) view returns (tuple(string name, string registrationNumber, string country, bool isActive, uint256 authorizedDate, uint256 totalIssued, uint256 dailyIssued, uint256 lastIssuedDate))",
    "function getAllInstitutionCount() view returns (uint256)",
    "function getInstitutionAddressByIndex(uint256 _index) view returns (address)",
    "function issueCertificate(string _certificateId, string _studentName, string _studentId, string _degree, string _institution, uint256 _issueDate, string _ipfsHash)",
    "function revokeCertificate(string _certificateId)",
    "function addInstitution(address _institution, string _name, string _registrationNumber, string _country)",
    "function removeInstitution(address _institution)",
    "function suspendInstitution(address _institution)",
    "function reactivateInstitution(address _institution)",
    "function setMaxDailyCertificates(uint256 _limit)",
    "event CertificateIssued(string indexed certificateId, string studentName, string institution, address indexed issuer, uint256 timestamp)",
    "event InstitutionAdded(address indexed institution, address indexed authorizedBy, string name, string registrationNumber, string country)",
    "event InstitutionRemoved(address indexed institution, address indexed removedBy)",
    "event InstitutionSuspended(address indexed institution, address indexed suspendedBy)",
    "event InstitutionReactivated(address indexed institution, address indexed reactivatedBy)",
  ];
}

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_CHAIN_ID = Number(process.env.RPC_CHAIN_ID || 11155111);
const RPC_CHAIN_NAME = process.env.RPC_CHAIN_NAME || (RPC_CHAIN_ID === 11155111 ? "sepolia" : `chain-${RPC_CHAIN_ID}`);

let _cachedProvider = null;
let _cachedSigner = null;

function formatRpcError(err, context) {
  const rawMessage = err?.shortMessage || err?.reason || err?.message || String(err);
  const message = String(rawMessage).toLowerCase();
  const code = String(err?.code ?? err?.info?.error?.code ?? "");

  if (code === "EAI_AGAIN" || code === "ENOTFOUND" || message.includes("eai_again") || message.includes("enotfound")) {
    return `${context}: DNS lookup failed for RPC host. Verify internet/DNS and RPC_URL (${RPC_URL}).`;
  }
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || message.includes("failed to detect network")) {
    return `${context}: Unable to connect to the RPC node at ${RPC_URL}. Check that the endpoint is reachable.`;
  }
  if (code === "-32005" || message.includes("too many requests") || message.includes("rate limit")) {
    return `${context}: RPC rate limited the request. Upgrade provider quota or reduce request frequency.`;
  }
  if (message.includes("insufficient funds")) {
    return `${context}: Signer wallet has insufficient ETH for gas on chain ${RPC_CHAIN_ID}.`;
  }

  return `${context}: ${rawMessage}`;
}

function wrapRpcError(err, context) {
  const wrapped = new Error(formatRpcError(err, context));
  wrapped.cause = err;
  return wrapped;
}

async function withRpcContext(context, operation) {
  try {
    return await operation();
  } catch (err) {
    throw wrapRpcError(err, context);
  }
}

// ── Provider & Contract Instances ───────────────────────────────────────────

function getProvider() {
  if (!RPC_URL) {
    throw new Error("Missing RPC_URL in backend .env");
  }
  if (!_cachedProvider) {
    _cachedProvider = new ethers.JsonRpcProvider(
      RPC_URL,
      { name: RPC_CHAIN_NAME, chainId: RPC_CHAIN_ID },
      {
        staticNetwork: true,
        batchMaxCount: 1,
      }
    );
  }
  return _cachedProvider;
}

function getSigner() {
  if (!PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY in backend .env");
  }
  if (!_cachedSigner) {
    _cachedSigner = new ethers.Wallet(PRIVATE_KEY, getProvider());
  }
  return _cachedSigner;
}

function getReadContract() {
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, getProvider());
}

function getWriteContract() {
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, getSigner());
}

// ── Certificate ID Generation ───────────────────────────────────────────────

async function generateCertificateId() {
  const contract = getReadContract();
  const count = await withRpcContext("Failed to fetch total certificates", () =>
    contract.getTotalCertificates()
  );
  const year = new Date().getFullYear();
  const seq = String(Number(count) + 1).padStart(3, "0");
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `CERT-${year}-${seq}-${rand}`;
}

// ── Single Certificate Issuance ─────────────────────────────────────────────

async function issueCertificate({
  certId,
  studentName,
  studentId,
  degree,
  institution,
  issueDate,
  ipfsHash,
}) {
  const contract = getWriteContract();
  const timestamp =
    typeof issueDate === "number"
      ? issueDate
      : Math.floor(new Date(issueDate).getTime() / 1000);

  const tx = await withRpcContext("Failed to submit certificate issuance transaction", () =>
    contract.issueCertificate(
      certId,
      studentName,
      studentId,
      degree,
      institution,
      timestamp,
      ipfsHash || ""
    )
  );
  const receipt = await withRpcContext("Failed while waiting for issuance transaction confirmation", () =>
    tx.wait()
  );

  return {
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: Number(receipt.gasUsed),
  };
}

// ── Batch Certificate Issuance ──────────────────────────────────────────────
// Issues certificates one-by-one with explicit nonce management.
// ethers.js v6's JsonRpcProvider caches getTransactionCount responses, so
// rapid sequential transactions can reuse a stale nonce (causing alternating
// failures). We fetch the nonce once upfront and manually increment it.

async function issueBatch(certificates, onProgress) {
  const signer = getSigner();
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
  const results = [];
  let succeeded = 0;
  let failed = 0;

  // Fetch the current nonce once — we'll manage it manually from here
  let nonce = await signer.getNonce("pending");

  for (let i = 0; i < certificates.length; i++) {
    const cert = certificates[i];
    try {
      const timestamp =
        typeof cert.issueDate === "number"
          ? cert.issueDate
          : Math.floor(new Date(cert.issueDate).getTime() / 1000);

      const tx = await contract.issueCertificate(
        cert.certId,
        cert.studentName,
        cert.studentId,
        cert.degree,
        cert.institution,
        timestamp,
        cert.ipfsHash || "",
        { nonce } // Explicit nonce to bypass provider cache
      );

      // Transaction was accepted — nonce is consumed regardless of revert
      nonce++;

      const receipt = await tx.wait();

      succeeded++;
      results.push({
        index: i,
        certId: cert.certId,
        status: "success",
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: Number(receipt.gasUsed),
      });
    } catch (err) {
      failed++;
      results.push({
        index: i,
        certId: cert.certId,
        status: "failed",
        error: err.reason || err.message,
      });

      // If the error happened before tx submission (e.g. gas estimation revert),
      // the nonce was NOT consumed — re-fetch to stay in sync
      try {
        nonce = await signer.getNonce("pending");
      } catch {
        // If nonce fetch fails, keep current value
      }
    }

    // Report progress
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: certificates.length,
        succeeded,
        failed,
        percent: Math.round(((i + 1) / certificates.length) * 100),
      });
    }
  }

  return { results, succeeded, failed, total: certificates.length };
}

// ── Verification ────────────────────────────────────────────────────────────

async function verifyCertificate(certId) {
  const contract = getReadContract();

  const exists = await withRpcContext("Failed to check certificate existence", () =>
    contract.certificateExistsCheck(certId)
  );
  if (!exists) return { exists: false };

  const cert = await withRpcContext("Failed to read certificate details", () =>
    contract.getCertificate(certId)
  );
  return {
    exists: true,
    isValid: cert.isValid,
    studentName: cert.studentName,
    studentId: cert.studentId,
    degree: cert.degree,
    institution: cert.institution,
    issueDate: Number(cert.issueDate),
    ipfsHash: cert.ipfsHash,
    issuer: cert.issuer,
  };
}

// ── Stats ───────────────────────────────────────────────────────────────────

async function getStats() {
  const contract = getReadContract();
  const [totalCerts, totalInst, totalRevoke] = await Promise.all([
    withRpcContext("Failed to fetch total certificates", () => contract.getTotalCertificates()),
    withRpcContext("Failed to fetch total institutions", () => contract.totalInstitutions()),
    withRpcContext("Failed to fetch total revocations", () => contract.totalRevocations()),
  ]);
  return {
    totalCertificates: Number(totalCerts),
    totalInstitutions: Number(totalInst),
    totalRevocations: Number(totalRevoke),
  };
}

// ── Check authorization ─────────────────────────────────────────────────────

async function isAuthorized() {
  const signer = getSigner();
  const contract = getReadContract();
  return contract.isAuthorizedInstitution(signer.address);
}

// ── Institution Authorization (Admin functions) ─────────────────────────────

/**
 * Authorize an institution on the blockchain.
 * Called by the admin backend when an application is approved.
 * @param {string} walletAddress - Institution's wallet address
 * @param {object} data - { name, registrationNumber, country }
 */
async function authorizeInstitution(walletAddress, data) {
  const contract = getWriteContract();
  const tx = await withRpcContext(
    `Failed to submit institution authorization tx for ${walletAddress}`,
    () =>
      contract.addInstitution(
        walletAddress,
        data.name,
        data.registrationNumber,
        data.country
      )
  );
  const receipt = await withRpcContext("Failed while waiting for institution authorization confirmation", () =>
    tx.wait()
  );
  return {
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: Number(receipt.gasUsed),
  };
}

/**
 * Remove an institution's authorization from the blockchain.
 * @param {string} walletAddress - Institution's wallet address
 */
async function deauthorizeInstitution(walletAddress) {
  const contract = getWriteContract();
  const tx = await withRpcContext(`Failed to submit deauthorization tx for ${walletAddress}`, () =>
    contract.removeInstitution(walletAddress)
  );
  const receipt = await withRpcContext("Failed while waiting for deauthorization confirmation", () =>
    tx.wait()
  );
  return {
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: Number(receipt.gasUsed),
  };
}

/**
 * Check if an address is authorized on the blockchain.
 * @param {string} walletAddress
 * @returns {Promise<boolean>}
 */
async function checkIfAuthorized(walletAddress) {
  const contract = getReadContract();
  return await withRpcContext(`Failed to check authorization for ${walletAddress}`, () =>
    contract.isAuthorizedInstitution(walletAddress)
  );
}

/**
 * Get full institution info from the blockchain.
 * @param {string} walletAddress
 * @returns {Promise<object>} Institution data
 */
async function getInstitutionInfo(walletAddress) {
  const contract = getReadContract();
  const [inst, isAuth] = await Promise.all([
    withRpcContext(`Failed to load institution record for ${walletAddress}`, () =>
      contract.getInstitution(walletAddress)
    ),
    withRpcContext(`Failed to load authorization state for ${walletAddress}`, () =>
      contract.isAuthorizedInstitution(walletAddress)
    ),
  ]);

  return {
    name: inst.name,
    registrationNumber: inst.registrationNumber,
    country: inst.country,
    isActive: inst.isActive,
    authorizedDate: Number(inst.authorizedDate),
    totalIssued: Number(inst.totalIssued),
    isAuthorized: isAuth,
  };
}

/**
 * Get all institutions from the blockchain (enumeration).
 * @returns {Promise<Array>} Array of institution objects
 */
async function getAllInstitutions() {
  const contract = getReadContract();
  const count = Number(
    await withRpcContext("Failed to fetch institution count", () =>
      contract.getAllInstitutionCount()
    )
  );
  const institutions = [];

  for (let i = 0; i < count; i++) {
    const address = await withRpcContext(`Failed to fetch institution address at index ${i}`, () =>
      contract.getInstitutionAddressByIndex(i)
    );
    const [inst, isAuth] = await Promise.all([
      withRpcContext(`Failed to fetch institution data for ${address}`, () =>
        contract.getInstitution(address)
      ),
      withRpcContext(`Failed to fetch authorization flag for ${address}`, () =>
        contract.isAuthorizedInstitution(address)
      ),
    ]);
    institutions.push({
      address,
      name: inst.name,
      registrationNumber: inst.registrationNumber,
      country: inst.country,
      isActive: inst.isActive,
      isAuthorized: isAuth,
      authorizedDate: Number(inst.authorizedDate),
      totalIssued: Number(inst.totalIssued),
    });
  }

  return institutions;
}

module.exports = {
  getProvider,
  getSigner,
  getReadContract,
  getWriteContract,
  generateCertificateId,
  issueCertificate,
  issueBatch,
  verifyCertificate,
  getStats,
  isAuthorized,
  authorizeInstitution,
  deauthorizeInstitution,
  checkIfAuthorized,
  getInstitutionInfo,
  getAllInstitutions,
};
