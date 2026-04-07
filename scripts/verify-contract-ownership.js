#!/usr/bin/env node
/**
 * Verify Contract Ownership & Authorization Capability
 * =====================================================
 * This script checks if the backend signer can authorize institutions
 */

const { ethers } = require("ethers");
require("dotenv").config();

const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;

// Minimal ABI for owner() call
const CONTRACT_ABI = [
  "function owner() view returns (address)",
  "function isAuthorized(address) view returns (bool)",
  "function addInstitution(address _institution, string _name, string _registrationNumber, string _country)",
  "function getAllInstitutionCount() view returns (uint256)",
];

async function main() {
  console.log("🔐 Contract Ownership Verification");
  console.log("=".repeat(60));

  try {
    // Setup
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
    const contractWithSigner = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

    console.log("\n📋 Signer & Contract Info:");
    console.log(`   Backend Signer Address: ${signer.address}`);
    console.log(`   Contract Address: ${CONTRACT_ADDRESS}`);
    console.log(`   Admin Wallet (Expected Owner): ${ADMIN_WALLET}`);

    // Check if contract exists
    console.log("\n🔍 Checking if contract exists...");
    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === "0x") {
      console.log("   ❌ ERROR: No contract code at this address!");
      console.log("   This address doesn't contain a smart contract.");
      return;
    }
    console.log("   ✅ Contract code found");

    // Get actual owner
    console.log("\n👑 Getting actual contract owner...");
    const owner = await contract.owner();
    console.log(`   Contract Owner: ${owner}`);
    
    if (owner.toLowerCase() === signer.address.toLowerCase()) {
      console.log("   ✅ Backend signer IS the owner");
    } else if (owner.toLowerCase() === ADMIN_WALLET.toLowerCase()) {
      console.log("   ✅ ADMIN_WALLET is the owner");
    } else {
      console.log(`   ❌ WARNING: Owner is different!`);
      console.log(`   Expected: ${ADMIN_WALLET} or ${signer.address}`);
      console.log(`   Actual: ${owner}`);
    }

    // Check institution count
    console.log("\n📊 Current Authorized Institutions:");
    const instCount = await contract.getAllInstitutionCount();
    console.log(`   Total: ${Number(instCount)}`);

    // Try a test authorization (dry run)
    console.log("\n🧪 Testing Authorization Function...");
    const testWallet = "0x1234567890123456789012345678901234567890";
    
    try {
      // This will fail but we'll see the actual error
      console.log("   Attempting to call addInstitution (will fail for test wallet)...");
      const tx = await contractWithSigner.addInstitution(
        testWallet,
        "Test University",
        "TEST-123",
        "US",
        { gasLimit: 300000 }
      );
      console.log("   ✅ Transaction submitted:", tx.hash);
    } catch (err) {
      const errorMsg = err.message || String(err);
      console.log(`   ❌ Error: ${errorMsg}`);
      
      if (errorMsg.includes("onlyOwner") || errorMsg.includes("NotOwner")) {
        console.log("   💡 The signer is NOT the contract owner!");
        console.log("   💡 Solution: Deploy contract again or update PRIVATE_KEY");
      } else if (errorMsg.includes("insufficient funds") || errorMsg.includes("underpriced")) {
        console.log("   💡 Wallet has insufficient ETH for gas");
      } else if (errorMsg.includes("network")) {
        console.log("   💡 Network error - check RPC_URL and connectivity");
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("Summary:");
    console.log("  - If 'Contract Owner' doesn't match backend signer");
    console.log("  - Then addInstitution calls will always fail");
    console.log("  - Solution: Either:");
    console.log("    1. Redeploy contract with your backend wallet");
    console.log("    2. Or update backend PRIVATE_KEY to match contract owner");
    console.log("=".repeat(60));

  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
}

main().catch(console.error);
