const fs = require("fs");
const path = require("path");

const CertificateTemplate = require("../models/CertificateTemplate");
const { ensureMongoConnected } = require("../db/mongo");
const {
  ensureDirSync,
  getInstitutionTemplatesDir,
} = require("../utils/runtimePaths");

function normalizeWalletAddress(walletAddress) {
  return String(walletAddress || "").trim().toLowerCase();
}

function displayNameFromTemplateId(templateId) {
  return String(templateId || "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getInstitutionDir(walletAddress) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) {
    throw new Error("Wallet address is required");
  }

  const dir = path.join(getInstitutionTemplatesDir(), wallet);
  if (!fs.existsSync(dir)) {
    const ok = ensureDirSync(dir);
    if (!ok) {
      throw new Error(`Unable to create institution template directory: ${dir}`);
    }
  }
  return dir;
}

function getTemplatePath(walletAddress, templateId) {
  return path.join(getInstitutionDir(walletAddress), `${templateId}.html`);
}

// Mongo is the source of truth for institution templates — on serverless,
// the on-disk copy under EDULOCKA_STORAGE_ROOT (/tmp) does not survive
// between invocations, so a failed/skipped DB write here silently loses the
// template the moment the next request lands on a fresh instance. Give the
// connection a generous window (matches ensureDbConnected's middleware
// timeout) so a slow reconnect — e.g. after a long Gemini call drops the
// socket — doesn't masquerade as success.
async function canUseDatabase() {
  return ensureMongoConnected(8000);
}

class TemplatePersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplatePersistenceError";
    this.statusCode = 503;
  }
}

async function upsertInstitutionTemplate({
  walletAddress,
  templateId,
  html,
  source = "upload",
  placeholders = [],
  name,
}) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet || !templateId || !html) return null;
  if (!(await canUseDatabase())) {
    throw new TemplatePersistenceError(
      `Could not save template "${templateId}" — the database is temporarily unavailable. Please try again in a few seconds.`
    );
  }

  return CertificateTemplate.findOneAndUpdate(
    { walletAddress: wallet, templateId },
    {
      $set: {
        walletAddress: wallet,
        templateId,
        name: name || displayNameFromTemplateId(templateId),
        html,
        source,
        placeholders,
        deletedAt: null,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

async function restoreInstitutionTemplate(walletAddress, templateId) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet || !templateId || !(await canUseDatabase())) return false;

  const template = await CertificateTemplate.findOne({
    walletAddress: wallet,
    templateId,
    deletedAt: null,
  }).lean();

  if (!template) return false;

  fs.writeFileSync(getTemplatePath(wallet, template.templateId), template.html, "utf8");
  return true;
}

async function restoreInstitutionTemplates(walletAddress) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet || !(await canUseDatabase())) return [];

  const templates = await CertificateTemplate.find({
    walletAddress: wallet,
    deletedAt: null,
  })
    .sort({ updatedAt: -1 })
    .lean();

  for (const template of templates) {
    fs.writeFileSync(getTemplatePath(wallet, template.templateId), template.html, "utf8");
  }

  return templates;
}

async function listInstitutionTemplates(walletAddress) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet || !(await canUseDatabase())) return [];

  return CertificateTemplate.find({
    walletAddress: wallet,
    deletedAt: null,
  })
    .sort({ updatedAt: -1 })
    .lean();
}

async function getInstitutionTemplateHtml(walletAddress, templateId) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet || !templateId || !(await canUseDatabase())) return null;

  const template = await CertificateTemplate.findOne({
    walletAddress: wallet,
    templateId,
    deletedAt: null,
  }).lean();

  return template?.html || null;
}

async function markInstitutionTemplateDeleted(walletAddress, templateId) {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet || !templateId) return null;

  if (!(await canUseDatabase())) {
    throw new TemplatePersistenceError(
      `Could not delete template "${templateId}" — the database is temporarily unavailable. Please try again in a few seconds.`
    );
  }

  return CertificateTemplate.findOneAndUpdate(
    { walletAddress: wallet, templateId, deletedAt: null },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } },
    { new: true }
  );
}

module.exports = {
  displayNameFromTemplateId,
  getTemplatePath,
  listInstitutionTemplates,
  markInstitutionTemplateDeleted,
  normalizeWalletAddress,
  restoreInstitutionTemplate,
  restoreInstitutionTemplates,
  getInstitutionTemplateHtml,
  upsertInstitutionTemplate,
  TemplatePersistenceError,
};
