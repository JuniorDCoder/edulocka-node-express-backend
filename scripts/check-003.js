
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Certificate = require('../src/models/Certificate');

async function checkCertificates() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const targetCertId = 'CERT-2026-003-0PX';
    const cert = await Certificate.findOne({ certId: targetCertId });

    if (cert) {
      console.log(`✅ Found ${targetCertId} in database:`);
      console.log(JSON.stringify(cert, null, 2));
    } else {
      console.log(`❌ ${targetCertId} NOT found in database.`);
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkCertificates();
