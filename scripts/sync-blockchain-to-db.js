
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const blockchainService = require('../src/services/blockchainService');
const Certificate = require('../src/models/Certificate');

async function syncBlockchainToDb() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const contract = blockchainService.getReadContract();
    const totalOnChain = await contract.getAllCertificateIdsCount();
    console.log(`Total certificates on blockchain: ${totalOnChain}`);

    let syncedCount = 0;
    let alreadyExistsCount = 0;
    let failedCount = 0;

    for (let i = 0; i < totalOnChain; i++) {
      const certId = await contract.getCertificateIdByIndex(i);
      console.log(`Checking [${i+1}/${totalOnChain}] Certificate ID: ${certId}`);

      const existsInDb = await Certificate.findOne({ certId });
      if (existsInDb) {
        alreadyExistsCount++;
        continue;
      }

      console.log(`  🔍 Certificate ${certId} missing from DB. Fetching from blockchain...`);
      try {
        const certData = await blockchainService.verifyCertificate(certId);
        
        // Try to find the transaction hash and block number from events
        let txHash = 'unknown';
        let blockNumber = 0;
        try {
          const filter = contract.filters.CertificateIssued(certId);
          // Search last 1,000,000 blocks
          const currentBlock = await blockchainService.getProvider().getBlockNumber();
          const fromBlock = Math.max(0, currentBlock - 1000000);
          const events = await contract.queryFilter(filter, fromBlock, 'latest');
          if (events.length > 0) {
            txHash = events[0].transactionHash;
            blockNumber = events[0].blockNumber;
          }
        } catch (e) {
          console.warn(`    ⚠️ Could not find event for ${certId}: ${e.message}`);
        }

        const syncData = {
          certId,
          studentName: certData.studentName,
          studentId: certData.studentId || null,
          degree: certData.degree,
          institution: certData.institution,
          issueDate: new Date(Number(certData.issueDate) * 1000),
          studentWallet: certData.issuer, 
          blockchain: {
            txHash,
            blockNumber,
            gasUsed: 0,
            issuedAt: new Date(Number(certData.issueDate) * 1000),
          },
          ipfs: {
            ipfsHash: certData.ipfsHash,
          },
          status: certData.isValid ? 'issued' : 'revoked'
        };

        // Handle unique constraint on txHash if it's "unknown"
        if (txHash === 'unknown') {
          syncData.blockchain.txHash = `unknown-${certId}`;
        }

        await Certificate.create(syncData);

        console.log(`  ✅ Synced ${certId} to database.`);
        syncedCount++;
      } catch (err) {
        console.error(`  ❌ Failed to sync ${certId}:`, err.message);
        failedCount++;
      }
    }

    console.log('\n--- Sync Summary ---');
    console.log(`Total processed: ${totalOnChain}`);
    console.log(`Already in DB: ${alreadyExistsCount}`);
    console.log(`Newly synced: ${syncedCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log('--------------------');

    await mongoose.disconnect();
  } catch (err) {
    console.error('Fatal Sync Error:', err);
    process.exit(1);
  }
}

syncBlockchainToDb();
