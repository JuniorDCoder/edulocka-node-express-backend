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

// ── Provider & Contract Instances ───────────────────────────────────────────

function getProvider() {
  return new ethers.JsonRpcProvider(RPC_URL);
}

function getSigner() {
  const provider = getProvider();
  return new ethers.Wallet(PRIVATE_KEY, provider);
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
  const count = await contract.getTotalCertificates();
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

  const tx = await contract.issueCertificate(
    certId,
    studentName,
    studentId,
    degree,
    institution,
    timestamp,
    ipfsHash || ""
  );
  const receipt = await tx.wait();

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

  const exists = await contract.certificateExistsCheck(certId);
  if (!exists) return { exists: false };

  const cert = await contract.getCertificate(certId);
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
    contract.getTotalCertificates(),
    contract.totalInstitutions(),
    contract.totalRevocations(),
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
  const tx = await contract.addInstitution(
    walletAddress,
    data.name,
    data.registrationNumber,
    data.country
  );
  const receipt = await tx.wait();
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
  const tx = await contract.removeInstitution(walletAddress);
  const receipt = await tx.wait();
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
  return await contract.isAuthorizedInstitution(walletAddress);
}

/**
 * Get full institution info from the blockchain.
 * @param {string} walletAddress
 * @returns {Promise<object>} Institution data
 */
async function getInstitutionInfo(walletAddress) {
  const contract = getReadContract();
  const inst = await contract.getInstitution(walletAddress);
  const isAuth = await contract.isAuthorizedInstitution(walletAddress);

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
  const count = Number(await contract.getAllInstitutionCount());
  const institutions = [];

  for (let i = 0; i < count; i++) {
    const address = await contract.getInstitutionAddressByIndex(i);
    const inst = await contract.getInstitution(address);
    const isAuth = await contract.isAuthorizedInstitution(address);
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
