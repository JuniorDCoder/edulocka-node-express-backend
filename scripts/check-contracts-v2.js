const { ethers } = require('ethers');
require('dotenv').config();

async function main() {
    const rpcUrl = process.env.RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const newAddress = '0xfdc705f32A85AA367c73e4F3EB602Bf9018CeF3f';
    const currentAddress = '0x85eA3aA3c50121FE37fC9a48500CEaAa43b934b7';

    const abi = [
        "function totalCertificates() public view returns (uint256)",
        "function getAllCertificateIdsCount() public view returns (uint256)"
    ];

    async function check(address, label) {
        console.log(`Checking ${label}: ${address}`);
        try {
            const contract = new ethers.Contract(address, abi, provider);
            const count = await contract.totalCertificates();
            console.log(`  totalCertificates: ${count.toString()}`);
            const idsCount = await contract.getAllCertificateIdsCount();
            console.log(`  getAllCertificateIdsCount: ${idsCount.toString()}`);
        } catch (e) {
            console.log(`  Error: ${e.message}`);
        }
    }

    await check(newAddress, 'New Address (User suggested)');
    await check(currentAddress, 'Current Address (in .env)');
}

main().catch(console.error);
