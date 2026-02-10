// ============================================================================
// CSV Parser — Parse and normalize CSV/Excel files for bulk upload
// ============================================================================
// Supports: .csv, .xlsx, .xls
// Returns normalized array of certificate records

const fs = require("fs");
const path = require("path");
const csvParser = require("csv-parser");
const XLSX = require("xlsx");

// ── Expected CSV columns (case-insensitive, flexible naming) ────────────────

const COLUMN_MAP = {
  // studentName
  studentname: "studentName",
  student_name: "studentName",
  "student name": "studentName",
  name: "studentName",
  fullname: "studentName",
  full_name: "studentName",
  "full name": "studentName",

  // studentId
  studentid: "studentId",
  student_id: "studentId",
  "student id": "studentId",
  "student number": "studentId",
  "reg number": "studentId",
  "registration number": "studentId",
  matricnumber: "studentId",
  matric_number: "studentId",
  "matric number": "studentId",
  regno: "studentId",
  reg_no: "studentId",

  // degree
  degree: "degree",
  program: "degree",
  programme: "degree",
  course: "degree",
  qualification: "degree",
  certificate: "degree",
  "degree name": "degree",

  // institution
  institution: "institution",
  school: "institution",
  university: "institution",
  college: "institution",
  "institution name": "institution",

  // issueDate
  issuedate: "issueDate",
  issue_date: "issueDate",
  "issue date": "issueDate",
  date: "issueDate",
  "date issued": "issueDate",
  "graduation date": "issueDate",
  graddate: "issueDate",

  // email (optional)
  email: "email",
  "email address": "email",
  emailaddress: "email",
  "student email": "email",
  studentemail: "email",
};

// ── Parse CSV file ──────────────────────────────────────────────────────────

function parseCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on("data", (row) => {
        results.push(normalizeRow(row));
      })
      .on("end", () => {
        resolve(results);
      })
      .on("error", (err) => {
        reject(new Error(`CSV parsing failed: ${err.message}`));
      });
  });
}

// ── Parse Excel file ────────────────────────────────────────────────────────

function parseExcelFile(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  return rawData.map(normalizeRow);
}

// ── Parse any supported file ────────────────────────────────────────────────

async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".csv") {
    return parseCSVFile(filePath);
  } else if (ext === ".xlsx" || ext === ".xls") {
    return parseExcelFile(filePath);
  } else {
    throw new Error(`Unsupported file format: ${ext}. Use CSV or XLSX.`);
  }
}

// ── Normalize a row (map column names to standard fields) ───────────────────

function normalizeRow(row) {
  const normalized = {};

  for (const [rawKey, value] of Object.entries(row)) {
    const key = rawKey.trim().toLowerCase();
    const mappedKey = COLUMN_MAP[key];
    if (mappedKey) {
      normalized[mappedKey] = String(value).trim();
    }
  }

  return normalized;
}

// ── Generate sample CSV content ─────────────────────────────────────────────

function getSampleCSV() {
  return `studentName,studentId,degree,institution,issueDate,email
Alice Johnson,STU-2026-001,Bachelor of Science in Computer Science,MIT,2026-06-15,alice@example.com
Bob Smith,STU-2026-002,Master of Business Administration,Harvard,2026-06-15,bob@example.com
Carol Williams,STU-2026-003,Bachelor of Arts in Economics,Stanford,2026-06-15,carol@example.com`;
}

module.exports = {
  parseFile,
  parseCSVFile,
  parseExcelFile,
  normalizeRow,
  getSampleCSV,
  COLUMN_MAP,
};
