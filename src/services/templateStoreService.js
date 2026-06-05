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

async function canUseDatabase() {
  return ensureMongoConnected(2500);
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
    console.warn(`[templateStore] MongoDB unavailable; template "${templateId}" saved only to runtime storage.`);
    return null;
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
    console.warn(`[templateStore] MongoDB unavailable; template "${templateId}" deleted only from runtime storage.`);
    return null;
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
};
