#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

async function main() {
  const rootDir = path.resolve(__dirname, "..", "..");
  const docsDir = path.join(rootDir, "docs");
  const htmlPath = path.join(docsDir, "edulocka-guide.html");
  const pdfPath = path.join(docsDir, "Edulocka-Application-Guide.pdf");

  if (!fs.existsSync(htmlPath)) {
    throw new Error(`HTML source not found: ${htmlPath}`);
  }

  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    console.log(`PDF generated: ${pdfPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Failed to generate guide PDF:", err);
  process.exitCode = 1;
});
