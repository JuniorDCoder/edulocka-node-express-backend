
const { ethers } = require('ethers');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL = process.env.RPC_URL;

const ABI = [
  "function getAllCertificateIdsCount() view returns (uint256)",
  "function getCertificateIdByIndex(uint256 index) view returns (string)"
];

async function checkBlockchain() {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

    const count = await contract.getAllCertificateIdsCount();
    console.log(`Total certificates on-chain: ${count}`);

    for (let i = 0; i < count; i++) {
        const id = await contract.getCertificateIdByIndex(i);
        console.log(`[${i}] ${id}`);
    }

  } catch (err) {
    console.error('Fatal Error:', err);
  }
}

checkBlockchain();
