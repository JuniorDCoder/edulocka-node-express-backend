// ============================================================================
// InstitutionApplication Model — MongoDB schema for institution applications
// ============================================================================
// Stores all data for institutions applying to be authorized on Edulocka.
// Applications go through: pending → approved/rejected workflow.

const mongoose = require("mongoose");

const institutionApplicationSchema = new mongoose.Schema(
  {
    // ── Basic Institution Info ─────────────────────────────────────────────
    institutionName: {
      type: String,
      required: [true, "Institution name is required"],
      trim: true,
      maxlength: 200,
    },
    registrationNumber: {
      type: String,
      required: [true, "Registration number is required"],
      trim: true,
      maxlength: 100,
    },
    country: {
      type: String,
      required: [true, "Country is required"],
      trim: true,
      maxlength: 100,
    },

    // ── Wallet ────────────────────────────────────────────────────────────
    walletAddress: {
      type: String,
      required: [true, "Wallet address is required"],
      unique: true,
      lowercase: true,
      match: [/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"],
    },

    // ── Contact Details ───────────────────────────────────────────────────
    contactEmail: {
      type: String,
      required: [true, "Contact email is required"],
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email format"],
    },
    contactPhone: {
      type: String,
      trim: true,
      maxlength: 30,
    },
    physicalAddress: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    website: {
      type: String,
      trim: true,
      maxlength: 300,
    },

    // ── Authorized Person ─────────────────────────────────────────────────
    authorizedPersonName: {
      type: String,
      required: [true, "Authorized person name is required"],
      trim: true,
      maxlength: 200,
    },
    authorizedPersonTitle: {
      type: String,
      trim: true,
      maxlength: 100,
    },

    // ── Documents (file paths stored on server) ───────────────────────────
    documents: {
      registrationCert: { type: String, default: null },
      accreditationProof: { type: String, default: null },
      letterOfIntent: { type: String, default: null },
      idDocument: { type: String, default: null },
    },

    // ── Application Status ────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "under_review", "approved", "rejected"],
      default: "pending",
    },
    appliedDate: {
      type: Date,
      default: Date.now,
    },
    reviewedDate: {
      type: Date,
      default: null,
    },
    reviewedBy: {
      type: String, // Admin wallet address who reviewed
      default: null,
    },
    rejectionReason: {
      type: String,
      default: null,
    },

    // ── Verification Checklist (admin fills during review) ────────────────
    verificationChecks: {
      documentsVerified: { type: Boolean, default: false },
      registrationConfirmed: { type: Boolean, default: false },
      accreditationConfirmed: { type: Boolean, default: false },
      contactVerified: { type: Boolean, default: false },
    },

    // ── Blockchain Authorization ──────────────────────────────────────────
    blockchainTxHash: {
      type: String,
      default: null,
    },
    authorizedOnChain: {
      type: Boolean,
      default: false,
    },

    // ── Admin Notes ───────────────────────────────────────────────────────
    adminNotes: {
      type: String,
      default: "",
      maxlength: 2000,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
  }
);

// Index for quick lookups
institutionApplicationSchema.index({ status: 1, appliedDate: -1 });
institutionApplicationSchema.index({ walletAddress: 1 });
institutionApplicationSchema.index({ registrationNumber: 1 });

const InstitutionApplication = mongoose.model(
  "InstitutionApplication",
  institutionApplicationSchema
);

module.exports = InstitutionApplication;
