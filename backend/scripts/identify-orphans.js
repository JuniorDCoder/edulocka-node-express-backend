
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const blockchainService = require('../src/services/blockchainService');
const Certificate = require('../src/models/Certificate');

async function cleanupOrphans() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to DB:', mongoose.connection.name);

    const contract = blockchainService.getReadContract();
    const certificates = await Certificate.find({});
    console.log(`Total certificates in DB: ${certificates.length}`);

    let orphanedCount = 0;
    let validCount = 0;

    for (const cert of certificates) {
      process.stdout.write(`Checking ${cert.certId}... `);
      try {
        const exists = await contract.certificateExistsCheck(cert.certId);
        if (exists) {
          console.log('✅ Found on blockchain.');
          validCount++;
        } else {
          console.log('❌ NOT found on blockchain.');
          orphanedCount++;
          console.log(`  -> Certificate ${cert.certId} is an orphan (not on current contract: ${process.env.CONTRACT_ADDRESS})`);
        }
      } catch (err) {
        console.log(`⚠️ Error checking: ${err.message}`);
      }
    }

    console.log('\n--- Cleanup Summary ---');
    console.log(`Total DB records: ${certificates.length}`);
    console.log(`Valid (on-chain): ${validCount}`);
    console.log(`Orphans (ghosts): ${orphanedCount}`);
    console.log('-----------------------');

    await mongoose.disconnect();
  } catch (err) {
    console.error('Fatal Error:', err);
    process.exit(1);
  }
}

cleanupOrphans();
