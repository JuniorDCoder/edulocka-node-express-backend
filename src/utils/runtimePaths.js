const fs = require("fs");
const os = require("os");
const path = require("path");

function isServerlessRuntime() {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.NOW_REGION
  );
}

function getBackendRoot() {
  // backend/src/utils -> backend
  return path.resolve(__dirname, "..", "..");
}

function getStorageRoot() {
  if (process.env.EDULOCKA_STORAGE_ROOT) return process.env.EDULOCKA_STORAGE_ROOT;
  return isServerlessRuntime() ? path.join(os.tmpdir(), "edulocka") : getBackendRoot();
}

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function getTemplatesDir() {
  // Shipped with the deployment (read-only on serverless)
  return path.join(getBackendRoot(), "templates");
}

function getUploadsDir() {
  return path.join(getStorageRoot(), "uploads");
}

function getInstitutionDocsDir() {
  return path.join(getUploadsDir(), "institution-docs");
}

function getOutputDir() {
  return path.join(getStorageRoot(), "output");
}

function getCertificatesOutputDir() {
  return path.join(getOutputDir(), "certificates");
}

function getQRCodesOutputDir() {
  return path.join(getOutputDir(), "qrcodes");
}

function getExportsOutputDir() {
  return path.join(getOutputDir(), "exports");
}

function getInstitutionTemplatesDir() {
  // Custom templates are runtime data → must be writable (e.g. /tmp on Vercel)
  return path.join(getStorageRoot(), "templates", "institutions");
}

module.exports = {
  isServerlessRuntime,
  getBackendRoot,
  getStorageRoot,
  ensureDirSync,
  getTemplatesDir,
  getUploadsDir,
  getInstitutionDocsDir,
  getOutputDir,
  getCertificatesOutputDir,
  getQRCodesOutputDir,
  getExportsOutputDir,
  getInstitutionTemplatesDir,
};

