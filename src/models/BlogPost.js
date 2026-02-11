// ============================================================================
// BlogPost Model — MongoDB schema for Edulocka blog content
// ============================================================================
// Blog workflow:
//   draft -> pending_review -> published
//                           -> rejected

const mongoose = require("mongoose");

const blogPostSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
      maxlength: 180,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 220,
    },
    excerpt: {
      type: String,
      trim: true,
      maxlength: 400,
      default: "",
    },
    contentMarkdown: {
      type: String,
      required: [true, "Content is required"],
      maxlength: 200000,
    },
    coverImageUrl: {
      type: String,
      trim: true,
      maxlength: 2048,
      default: "",
    },
    tags: {
      type: [String],
      default: [],
    },

    // Author
    authorWallet: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
      match: [/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"],
    },
    authorDisplayName: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },

    // Status workflow
    status: {
      type: String,
      enum: ["draft", "pending_review", "published", "rejected"],
      default: "pending_review",
      index: true,
    },

    // Deterministic content hash for integrity and blockchain anchoring metadata
    contentHash: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [/^[a-f0-9]{64}$/, "Invalid SHA-256 content hash"],
    },
    readTimeMinutes: {
      type: Number,
      default: 1,
      min: 1,
    },

    // Review lifecycle
    reviewNote: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    reviewedBy: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastEditedAt: {
      type: Date,
      default: Date.now,
    },

    // Chain anchor metadata (no gas write): chain context at approval time
    chainAnchor: {
      chainId: { type: Number, default: null },
      chainName: { type: String, default: null },
      blockNumber: { type: Number, default: null },
      blockHash: { type: String, default: null },
      anchoredAt: { type: Date, default: null },
      anchorError: { type: String, default: "" },
    },
  },
  {
    timestamps: true,
  }
);

blogPostSchema.index({ slug: 1 }, { unique: true });
blogPostSchema.index({ status: 1, publishedAt: -1, createdAt: -1 });
blogPostSchema.index({ authorWallet: 1, updatedAt: -1 });
blogPostSchema.index({ tags: 1, publishedAt: -1 });

const BlogPost = mongoose.model("BlogPost", blogPostSchema);

module.exports = BlogPost;
