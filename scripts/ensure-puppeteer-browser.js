const fs = require("fs");
const { spawnSync } = require("child_process");

const BROWSER_ENV_VARS = [
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_BIN",
  "GOOGLE_CHROME_BIN",
  "CHROMIUM_PATH",
];
const COMMON_BROWSER_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/opt/google/chrome/chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function resolveExistingBrowserPath() {
  for (const envVar of BROWSER_ENV_VARS) {
    const candidate = String(process.env[envVar] || "").trim();
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const puppeteer = require("puppeteer");
    const bundledPath = puppeteer.executablePath();
    if (bundledPath && fs.existsSync(bundledPath)) {
      return bundledPath;
    }
  } catch {
    // Ignore and fall through to common system paths.
  }

  for (const candidate of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function main() {
  const existingPath = resolveExistingBrowserPath();
  if (existingPath) {
    console.log(`[puppeteer] Using browser at ${existingPath}`);
    return;
  }

  if (String(process.env.PUPPETEER_SKIP_DOWNLOAD || "").toLowerCase() === "true") {
    console.warn("[puppeteer] Browser download skipped by PUPPETEER_SKIP_DOWNLOAD=true");
    return;
  }

  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const install = spawnSync(command, ["puppeteer", "browsers", "install", "chrome"], {
    stdio: "inherit",
  });

  if (install.status !== 0) {
    process.exit(install.status || 1);
  }

  const installedPath = resolveExistingBrowserPath();
  if (!installedPath) {
    console.error("[puppeteer] Chrome install finished but no executable could be resolved.");
    process.exit(1);
  }

  console.log(`[puppeteer] Installed browser at ${installedPath}`);
}

main();
