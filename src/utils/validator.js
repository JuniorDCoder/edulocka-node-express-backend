// ============================================================================
// Validator — Validate certificate data before blockchain issuance
// ============================================================================
// Catches errors BEFORE spending gas on transactions

// ── Validate a single certificate record ────────────────────────────────────

function validateCertificate(cert, index = 0) {
  const errors = [];
  const warnings = [];

  // Required fields
  if (!cert.studentName || cert.studentName.trim().length === 0) {
    errors.push({ field: "studentName", message: "Student name is required", row: index + 1 });
  } else if (cert.studentName.length > 200) {
    errors.push({ field: "studentName", message: "Student name too long (max 200 chars)", row: index + 1 });
  }

  if (!cert.studentId || cert.studentId.trim().length === 0) {
    errors.push({ field: "studentId", message: "Student ID is required", row: index + 1 });
  }

  if (!cert.degree || cert.degree.trim().length === 0) {
    errors.push({ field: "degree", message: "Degree/program is required", row: index + 1 });
  }

  if (!cert.institution || cert.institution.trim().length === 0) {
    errors.push({ field: "institution", message: "Institution name is required", row: index + 1 });
  }

  if (!cert.issueDate) {
    errors.push({ field: "issueDate", message: "Issue date is required", row: index + 1 });
  } else {
    const date = new Date(cert.issueDate);
    if (isNaN(date.getTime())) {
      errors.push({ field: "issueDate", message: `Invalid date format: "${cert.issueDate}". Use YYYY-MM-DD.`, row: index + 1 });
    }
  }

  // Optional email validation
  if (cert.email && cert.email.trim().length > 0) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cert.email)) {
      warnings.push({ field: "email", message: `Invalid email: "${cert.email}"`, row: index + 1 });
    }
  }

  // Name sanity checks
  if (cert.studentName && /\d{4,}/.test(cert.studentName)) {
    warnings.push({ field: "studentName", message: "Student name contains numbers — is this correct?", row: index + 1 });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Validate an entire batch ────────────────────────────────────────────────

function validateBatch(certificates) {
  const allErrors = [];
  const allWarnings = [];
  const validRecords = [];
  const invalidRecords = [];

  // Check for duplicates within the batch
  const seenStudentIds = new Map();
  const seenEmails = new Map();

  for (let i = 0; i < certificates.length; i++) {
    const cert = certificates[i];
    const { valid, errors, warnings } = validateCertificate(cert, i);

    // Duplicate student ID check
    if (cert.studentId) {
      if (seenStudentIds.has(cert.studentId)) {
        allWarnings.push({
          field: "studentId",
          message: `Duplicate student ID "${cert.studentId}" (also in row ${seenStudentIds.get(cert.studentId)})`,
          row: i + 1,
        });
      }
      seenStudentIds.set(cert.studentId, i + 1);
    }

    // Duplicate email check
    if (cert.email) {
      if (seenEmails.has(cert.email)) {
        allWarnings.push({
          field: "email",
          message: `Duplicate email "${cert.email}" (also in row ${seenEmails.get(cert.email)})`,
          row: i + 1,
        });
      }
      seenEmails.set(cert.email, i + 1);
    }

    allErrors.push(...errors);
    allWarnings.push(...warnings);

    if (valid) {
      validRecords.push({ ...cert, _row: i + 1 });
    } else {
      invalidRecords.push({ ...cert, _row: i + 1, _errors: errors });
    }
  }

  return {
    totalRows: certificates.length,
    validCount: validRecords.length,
    invalidCount: invalidRecords.length,
    hasErrors: allErrors.length > 0,
    errors: allErrors,
    warnings: allWarnings,
    validRecords,
    invalidRecords,
  };
}

// ── Check if required columns are present ───────────────────────────────────

function validateColumns(records) {
  if (!records || records.length === 0) {
    return { valid: false, missing: ["No data rows found in file"] };
  }

  const firstRecord = records[0];
  const requiredFields = ["studentName", "studentId", "degree", "institution", "issueDate"];
  const missing = requiredFields.filter((field) => !(field in firstRecord));

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      hint: `Your CSV must have columns for: ${requiredFields.join(", ")}. ` +
        `Accepted column names include variations like "Student Name", "student_name", "name", etc.`,
    };
  }

  return { valid: true, missing: [] };
}

module.exports = {
  validateCertificate,
  validateBatch,
  validateColumns,
};
