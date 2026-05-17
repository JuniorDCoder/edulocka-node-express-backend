
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const blockchainService = require('../src/services/blockchainService');
const Certificate = require('../src/models/Certificate');

async function repairBlockNumbers() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const contract = blockchainService.getReadContract();
    
    // Find certificates with blockNumber 0 or txHash starting with "unknown-"
    const certsToRepair = await Certificate.find({
      $or: [
        { "blockchain.blockNumber": 0 },
        { "blockchain.txHash": /^unknown-/ }
      ]
    });

    console.log(`Found ${certsToRepair.length} certificates to repair.`);

    for (const cert of certsToRepair) {
      const certId = cert.certId;
      console.log(`Repairing ${certId}...`);

      try {
        const filter = contract.filters.CertificateIssued(certId);
        // We know the contract is new, so it was deployed recently.
        // Alchemy Free tier has 10 block range limit for eth_getLogs if fromBlock is too old.
        // Let's try to find the deployment block or a recent range.
        
        // Actually, if it's the 10 block range limit, we might need to be more clever or
        // just use a different RPC for syncing if possible, but let's try a smaller range if we can find where it started.
        // Or better, let's try to get logs from the last 1000 blocks in chunks if needed.
        
        let txHash = null;
        let blockNumber = 0;

        const currentBlock = await blockchainService.getProvider().getBlockNumber();
        const startBlock = 10850000; // Recent range
        const chunkSize = 10;
        
        console.log(`  Searching for events from block ${startBlock} to ${currentBlock} in chunks of ${chunkSize}...`);
        
        for (let start = currentBlock; start > startBlock; start -= chunkSize) {
            const from = Math.max(0, start - chunkSize);
            const to = start;
            if (start % 1000 === 0) console.log(`    ...checking block ${start}`);
            try {
                const events = await contract.queryFilter(filter, from, to);
                if (events.length > 0) {
                    txHash = events[0].transactionHash;
                    blockNumber = events[0].blockNumber;
                    console.log(`  ✅ Found event at block ${blockNumber}`);
                    break;
                }
            } catch (e) {
                // If chunk fails, just continue
            }
        }

        if (txHash && blockNumber) {
          cert.blockchain.txHash = txHash;
          cert.blockchain.blockNumber = blockNumber;
          await cert.save();
          console.log(`  ✅ Fixed ${certId}: txHash=${txHash}, blockNumber=${blockNumber}`);
        } else {
          console.log(`  ❌ Could not find event for ${certId} in last 1000 blocks.`);
        }
      } catch (err) {
        console.error(`  ❌ Error repairing ${certId}:`, err.message);
      }
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Fatal Repair Error:', err);
    process.exit(1);
  }
}

repairBlockNumbers();
