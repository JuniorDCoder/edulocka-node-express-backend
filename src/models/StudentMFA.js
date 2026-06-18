const mongoose = require("mongoose");

const studentMFASchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  institution: { type: String, required: true },

  mfaEnabled: { type: Boolean, default: false },
  mfaMethod: {
    type: String,
    enum: ["authenticator", "pin", "email", null],
    default: null,
  },

  // TOTP (Authenticator App)
  totp: {
    secret: { type: String, default: null },
    verified: { type: Boolean, default: false },
  },

  // PIN
  pin: {
    hash: { type: String, default: null },
  },

  // Email OTP
  emailOtp: {
    email: { type: String, default: null },
    code: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },

  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() },
});

studentMFASchema.index({ studentId: 1, institution: 1 }, { unique: true });

studentMFASchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("StudentMFA", studentMFASchema);
