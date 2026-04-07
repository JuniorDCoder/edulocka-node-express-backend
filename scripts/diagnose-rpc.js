#!/usr/bin/env node

/**
 * RPC Diagnostic Script
 * Tests your Ethereum RPC connection and identifies issues
 */

require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_CHAIN_ID = Number(process.env.RPC_CHAIN_ID || 11155111);

console.log("🔍 RPC Diagnostic Tool");
console.log("=".repeat(60));
console.log(`RPC URL: ${RPC_URL || "NOT SET"}`);
console.log(`Chain ID: ${RPC_CHAIN_ID}`);
console.log(`Private Key: ${PRIVATE_KEY ? "SET" : "NOT SET"}`);
console.log("=".repeat(60));

async function diagnose() {
  try {
    // 1. Check if RPC_URL is set
    if (!RPC_URL) {
      console.error("❌ ERROR: RPC_URL environment variable is not set!");
      process.exit(1);
    }

    // 2. Create provider
    console.log("\n📡 Creating ethers.js provider...");
    const provider = new ethers.JsonRpcProvider(RPC_URL, {
      chainId: RPC_CHAIN_ID,
      name: `chain-${RPC_CHAIN_ID}`,
    });

    // 3. Test basic RPC call (getBlockNumber)
    console.log("\n🧪 Test 1: Fetching latest block number...");
    let blockNumber;
    try {
      blockNumber = await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Request timeout (5s)")), 5000)
        )
      ]);
      console.log(`✅ SUCCESS: Latest block number = ${blockNumber}`);
    } catch (err) {
      console.error(`❌ FAILED: ${err.message}`);
      if (err.code === "UNSUPPORTED_OPERATION" && err.operation === "bodyJson") {
        console.error("   → RPC returned invalid JSON. Likely RATE LIMIT or endpoint issue.");
        console.error("   → Try: 1) Wait a few seconds and retry");
        console.error("          2) Check if you're hitting free tier rate limits (1 req/sec)");
        console.error("          3) Upgrade your Infura plan");
        console.error("          4) Use a different RPC provider (Alchemy, etc)");
      }
      return;
    }

    // 4. Test transaction estimation (common operation)
    console.log("\n🧪 Test 2: Estimating gas price...");
    try {
      const feeData = await Promise.race([
        provider.getFeeData(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Request timeout (5s)")), 5000)
        )
      ]);
      console.log(`✅ SUCCESS: Gas price = ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);
    } catch (err) {
      console.error(`❌ FAILED: ${err.message}`);
      return;
    }

    // 5. Check wallet balance
    if (!PRIVATE_KEY) {
      console.warn("\n⚠️  PRIVATE_KEY not set. Skipping wallet balance check.");
    } else {
      console.log("\n🧪 Test 3: Checking wallet balance...");
      try {
        const signer = new ethers.Wallet(PRIVATE_KEY, provider);
        const balance = await Promise.race([
          provider.getBalance(signer.address),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Request timeout (5s)")), 5000)
          )
        ]);
        const ethBalance = ethers.formatEther(balance);
        console.log(`✅ SUCCESS: Wallet address = ${signer.address}`);
        console.log(`✅ SUCCESS: Wallet balance = ${ethBalance} ETH`);
        
        if (ethBalance === "0.0") {
          console.warn("⚠️  WARNING: Wallet has 0 ETH. You won't be able to submit transactions!");
          console.warn("   → Go to Sepolia faucets and request test ETH");
          console.warn("   → https://sepoliafaucet.com or https://www.alchemy.com/faucets/ethereum-sepolia");
        }
      } catch (err) {
        console.error(`❌ FAILED: ${err.message}`);
        return;
      }
    }

    // 6. Test contract call simulation
    console.log("\n🧪 Test 4: Testing JSON-RPC calls with retry logic...");
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < 3; i++) {
      try {
        const block = await Promise.race([
          provider.getBlock("latest"),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Timeout")), 5000)
          )
        ]);
        console.log(`   Attempt ${i + 1}: ✅ SUCCESS`);
        successCount++;
      } catch (err) {
        console.log(`   Attempt ${i + 1}: ❌ FAILED - ${err.message}`);
        failCount++;
      }
      
      // Wait 1 second between attempts
      if (i < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`\n📊 Results: ${successCount}/3 calls succeeded, ${failCount}/3 failed`);

    if (failCount > 0) {
      console.error("\n🚨 RPC CONNECTION UNSTABLE");
      console.error("Recommendations:");
      console.error("1. Check if Infura free tier rate limit (1 req/sec) is being exceeded");
      console.error("2. Try using a premium Infura plan or different provider:");
      console.error("   - Alchemy: https://www.alchemy.com");
      console.error("   - QuickNode: https://www.quicknode.com");
      console.error("3. Add retry logic to blockchain operations (currently being added)");
      console.error("4. Temporarily reduce batch size from your bulk issuance CSV");
    } else {
      console.log("\n✅ RPC CONNECTION HEALTHY - Ready for bulk issuance!");
    }

  } catch (err) {
    console.error("❌ Diagnostic failed:", err.message);
    process.exit(1);
  }
}

diagnose();
