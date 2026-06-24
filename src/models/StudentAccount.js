const mongoose = require("mongoose");
const crypto = require("crypto");

const studentAccountSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true, index: true },
  passphraseHash: { type: String, required: true },
  salt: { type: String, required: true },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() },
});

studentAccountSchema.statics.hashPassphrase = function (passphrase, salt) {
  if (!salt) salt = crypto.randomBytes(32).toString("hex");
  const hash = crypto.pbkdf2Sync(passphrase, salt, 100000, 64, "sha512").toString("hex");
  return { hash, salt };
};

studentAccountSchema.methods.verifyPassphrase = function (passphrase) {
  const hash = crypto.pbkdf2Sync(passphrase, this.salt, 100000, 64, "sha512").toString("hex");
  return hash === this.passphraseHash;
};

studentAccountSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("StudentAccount", studentAccountSchema);
