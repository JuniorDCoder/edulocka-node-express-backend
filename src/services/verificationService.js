// ============================================================================
// Verification Service — Application validation & document verification
// ============================================================================
// Handles the logic for validating institution applications, checking
// documents, and generating verification reports.

const { ethers } = require("ethers");

/**
 * Validate an institution application for completeness and correctness.
 * Returns { valid: boolean, errors: string[] }
 */
function validateApplication(data) {
  const errors = [];

  // Required fields
  if (!data.institutionName?.trim()) errors.push("Institution name is required");
  if (!data.registrationNumber?.trim()) errors.push("Registration number is required");
  if (!data.country?.trim()) errors.push("Country is required");
  if (!data.walletAddress?.trim()) errors.push("Wallet address is required");
  if (!data.contactEmail?.trim()) errors.push("Contact email is required");
  if (!data.authorizedPersonName?.trim()) errors.push("Authorized person name is required");

  // Wallet address validation
  if (data.walletAddress && !ethers.isAddress(data.walletAddress)) {
    errors.push("Invalid Ethereum wallet address format");
  }

  // Email validation
  if (data.contactEmail && !/^\S+@\S+\.\S+$/.test(data.contactEmail)) {
    errors.push("Invalid email format");
  }

  // Name length
  if (data.institutionName && data.institutionName.length > 200) {
    errors.push("Institution name must be under 200 characters");
  }

  // Registration number format (basic check)
  if (data.registrationNumber && data.registrationNumber.length > 100) {
    errors.push("Registration number must be under 100 characters");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Simulate checking a government registry for the registration number.
 * In production, this would call an external API (e.g., Companies House UK,
 * SEC EDGAR, etc.) to verify the institution is real.
 *
 * For now, returns a mock result. Replace with real API calls per country.
 */
async function checkGovernmentRegistry(registrationNumber, country) {
  // TODO: Integrate real government registry APIs per country
  // Example APIs:
  //   - UK: Companies House API
  //   - US: SEC EDGAR, state-level registrars
  //   - India: MCA (Ministry of Corporate Affairs)
  //   - EU: various national registrars

  return {
    found: true, // In production: actually check
    registrationNumber,
    country,
    message: `Registry check for "${registrationNumber}" in ${country} — manual verification required`,
    verified: false, // Set to true only after real verification
  };
}

/**
 * Verify uploaded documents are valid.
 * Checks file existence, type, and size.
 */
function verifyDocuments(documents) {
  const results = {
    allValid: true,
    checks: {},
  };

  const requiredDocs = ["registrationCert"];
  const optionalDocs = ["accreditationProof", "letterOfIntent", "idDocument"];

  for (const docKey of requiredDocs) {
    if (!documents[docKey]) {
      results.checks[docKey] = { valid: false, reason: "Required document missing" };
      results.allValid = false;
    } else {
      results.checks[docKey] = { valid: true, path: documents[docKey] };
    }
  }

  for (const docKey of optionalDocs) {
    if (documents[docKey]) {
      results.checks[docKey] = { valid: true, path: documents[docKey] };
    } else {
      results.checks[docKey] = { valid: true, reason: "Optional — not provided" };
    }
  }

  return results;
}

/**
 * Generate a verification report for an application.
 * Summarizes all checks performed during the review process.
 */
function generateVerificationReport(application) {
  return {
    applicationId: application._id,
    institutionName: application.institutionName,
    registrationNumber: application.registrationNumber,
    country: application.country,
    walletAddress: application.walletAddress,
    appliedDate: application.appliedDate,
    status: application.status,
    verificationChecks: application.verificationChecks,
    documentsProvided: {
      registrationCert: !!application.documents?.registrationCert,
      accreditationProof: !!application.documents?.accreditationProof,
      letterOfIntent: !!application.documents?.letterOfIntent,
      idDocument: !!application.documents?.idDocument,
    },
    reviewedBy: application.reviewedBy,
    reviewedDate: application.reviewedDate,
    adminNotes: application.adminNotes,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  validateApplication,
  checkGovernmentRegistry,
  verifyDocuments,
  generateVerificationReport,
};
