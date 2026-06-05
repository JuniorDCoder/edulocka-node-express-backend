const mongoose = require("mongoose");

const certificateTemplateSchema = new mongoose.Schema({
  templateId: { type: String, required: true, index: true },
  walletAddress: { type: String, required: true, lowercase: true, index: true },
  name: { type: String, required: true },
  html: { type: String, required: true },
  source: {
    type: String,
    enum: ["upload", "ai", "builder", "ai_edit"],
    default: "upload",
  },
  placeholders: { type: [String], default: [] },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: () => new Date(), index: true },
  updatedAt: { type: Date, default: () => new Date() },
});

certificateTemplateSchema.index(
  { walletAddress: 1, templateId: 1 },
  { unique: true }
);

certificateTemplateSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("CertificateTemplate", certificateTemplateSchema);
