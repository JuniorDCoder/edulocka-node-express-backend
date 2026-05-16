
const { ethers } = require('ethers');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;

const ABI = [
  "function certificateExistsCheck(string _certificateId) view returns (bool)",
  "function getCertificate(string _certificateId) view returns (tuple(string studentName, string studentId, string degree, string institution, uint256 issueDate, string ipfsHash, address issuer, bool isValid, bool exists))"
];

async function checkBlockchain() {
  try {
    console.log(`Using RPC: ${RPC_URL}`);
    console.log(`Using Contract: ${CONTRACT_ADDRESS}`);
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

    const certIds = ['CERT-2026-003-0PX', 'CERT-2026-004-2YC'];

    for (const certId of certIds) {
      console.log(`\nChecking ${certId}...`);
      try {
        const exists = await contract.certificateExistsCheck(certId);
        console.log(`Exists (existsCheck): ${exists}`);

        if (exists) {
            const cert = await contract.getCertificate(certId);
            console.log(`Certificate details:`, cert);
        } else {
            console.log(`❌ Certificate NOT found on blockchain.`);
        }
      } catch (err) {
        console.error(`Error checking ${certId}:`, err.message);
        if (err.data) console.error(`Error data: ${err.data}`);
      }
    }

  } catch (err) {
    console.error('Fatal Error:', err);
  }
}

checkBlockchain();
