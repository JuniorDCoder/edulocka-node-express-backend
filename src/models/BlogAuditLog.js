// ============================================================================
// BlogAuditLog Model — Persistent audit trail for blog actions
// ============================================================================

const mongoose = require("mongoose");

const blogAuditLogSchema = new mongoose.Schema(
  {
    blogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BlogPost",
      default: null,
      index: true,
    },
    blogTitle: {
      type: String,
      trim: true,
      default: "",
      maxlength: 180,
    },
    blogSlug: {
      type: String,
      trim: true,
      default: "",
      maxlength: 220,
    },
    action: {
      type: String,
      enum: [
        "create",
        "update",
        "submit_review",
        "approve",
        "reject",
        "delete",
      ],
      required: true,
      index: true,
    },
    actorWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^0x[a-fA-F0-9]{40}$/, "Invalid actor wallet address"],
      index: true,
    },
    actorRole: {
      type: String,
      enum: ["author", "admin", "system"],
      required: true,
      index: true,
    },
    note: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },
    statusBefore: {
      type: String,
      enum: ["draft", "pending_review", "published", "rejected", null],
      default: null,
    },
    statusAfter: {
      type: String,
      enum: ["draft", "pending_review", "published", "rejected", null],
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

blogAuditLogSchema.index({ createdAt: -1 });
blogAuditLogSchema.index({ blogId: 1, createdAt: -1 });
blogAuditLogSchema.index({ action: 1, createdAt: -1 });

const BlogAuditLog = mongoose.model("BlogAuditLog", blogAuditLogSchema);

module.exports = BlogAuditLog;
