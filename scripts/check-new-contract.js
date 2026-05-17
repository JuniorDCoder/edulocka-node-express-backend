const { ethers } = require('ethers');
require('dotenv').config();

async function main() {
    const rpcUrl = process.env.RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const newAddress = '0xfdc705f32A85AA367c73e4F3EB602Bf9018CeF3f';
    const oldAddress = '0x85eA3aA3c50121FE37fC9a48500CEaAa43b934b7';

    const abi = [
        "function getCertificateCount() public view returns (uint256)",
        "function getCertificate(string memory _certId) public view returns (tuple(string certId, string studentName, address studentWallet, string studentId, string degree, string institution, uint256 issueDate, bool isRevoked))"
    ];

    console.log('Checking New Address:', newAddress);
    try {
        const contractNew = new ethers.Contract(newAddress, abi, provider);
        const countNew = await contractNew.getCertificateCount();
        console.log('Count on New Address:', countNew.toString());
    } catch (e) {
        console.log('Error checking New Address:', e.message);
    }

    console.log('\nChecking Old Address:', oldAddress);
    try {
        const contractOld = new ethers.Contract(oldAddress, abi, provider);
        const countOld = await contractOld.getCertificateCount();
        console.log('Count on Old Address:', countOld.toString());
    } catch (e) {
        console.log('Error checking Old Address:', e.message);
    }
}

main().catch(console.error);
