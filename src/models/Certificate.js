// Certificate Model — MongoDB schema for issued certificates with blockchain metadata
const mongoose = require("mongoose");

const certificateSchema = new mongoose.Schema({
  certId: { type: String, required: true, unique: true, index: true },
  studentName: { type: String, required: true },
  studentWallet: { type: String, required: true, index: true },
  studentId: { type: String, default: null },
  studentEmail: { type: String, default: null },
  degree: { type: String, required: true },
  institution: { type: String, required: true, index: true },
  issueDate: { type: Date, required: true },
  
  // Blockchain data
  blockchain: {
    txHash: { type: String, required: true, unique: true, index: true },
    blockNumber: { type: Number, required: true, index: true },
    gasUsed: { type: Number, default: null },
    issuedAt: { type: Date, default: () => new Date() },
  },
  
  // IPFS data
  ipfs: {
    documentHash: { type: String, default: null, index: true },
    ipfsHash: { type: String, default: null },
    pinned: { type: Boolean, default: false },
    gateway: { type: String, default: null },
  },
  
  // QR code
  qr: {
    saved: { type: Boolean, default: false },
    filePath: { type: String, default: null },
  },
  
  // Email delivery
  email: {
    sent: { type: Boolean, default: false },
    sentAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  
  // Status
  status: { type: String, enum: ["issued", "revoked"], default: "issued", index: true },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: String, default: null },
  revokedTxHash: { type: String, default: null },
  revokedBlockNumber: { type: Number, default: null },
  
  createdAt: { type: Date, default: () => new Date(), index: true },
  updatedAt: { type: Date, default: () => new Date() },
});

// Middleware to update updatedAt on modification
certificateSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Certificate", certificateSchema);
