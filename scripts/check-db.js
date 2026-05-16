
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Certificate = require('../src/models/Certificate');

async function checkCertificates() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const total = await Certificate.countDocuments();
    console.log(`Total certificates in DB: ${total}`);

    const targetCertId = 'CERT-2026-004-2YC';
    const cert = await Certificate.findOne({ certId: targetCertId });

    if (cert) {
      console.log(`✅ Found ${targetCertId} in database:`);
      console.log(JSON.stringify(cert, null, 2));
    } else {
      console.log(`❌ ${targetCertId} NOT found in database.`);
      
      const allCerts = await Certificate.find({}).sort({ createdAt: -1 }).limit(20);
      console.log('\nMost recent 20 certificates in DB:');
      allCerts.forEach(c => console.log(`- ${c.certId} (${c.studentName}) - ${c.createdAt}`));
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkCertificates();
