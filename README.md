# Edulocka Backend — Bulk Certificate Issuance System

Express.js backend that powers bulk certificate issuance with blockchain recording, PDF generation, QR codes, IPFS storage, and email delivery.

## Architecture

```
backend/
├── src/
│   ├── server.js                    # Express app entry point
│   ├── routes/api.js                # All API route definitions
│   ├── controllers/
│   │   ├── bulkController.js        # Bulk CSV upload, processing, downloads, reports
│   │   └── certificateController.js # Single issuance, verification, templates, QR, email
│   ├── services/
│   │   ├── blockchainService.js     # Ethers.js ↔ CertificateRegistry contract
│   │   ├── ipfsService.js           # Pinata IPFS upload (free tier)
│   │   ├── pdfService.js            # Puppeteer HTML→PDF generation
│   │   ├── emailService.js          # Nodemailer SMTP email delivery
│   │   └── qrService.js             # QR code generation (PNG, SVG, data URL)
│   └── utils/
│       ├── csvParser.js             # CSV/Excel parsing with flexible column mapping
│       └── validator.js             # Data validation before blockchain issuance
├── templates/
│   ├── default-certificate.html     # Handlebars HTML certificate template
│   └── email-template.html          # Handlebars HTML email template
├── uploads/                         # Temporary file storage (auto-cleaned)
├── output/                          # Generated PDFs, QR codes, exports
├── .env.example                     # Environment configuration template
└── package.json
```

## Quick Start

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Pinata JWT, SMTP credentials, etc.

# 3. Make sure Hardhat node is running (in smart-contracts/)
npx hardhat node

# 4. Start the backend
npm run dev
```

Server runs on **http://localhost:4000**

## API Endpoints

### Bulk Issuance
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/bulk/upload` | Upload CSV/XLSX, returns validation preview |
| `POST` | `/api/bulk/process` | Process validated batch (blockchain + PDF + QR) |
| `GET` | `/api/bulk/status/:jobId` | Poll processing progress |
| `GET` | `/api/bulk/download/:jobId` | Download all certificates as ZIP |
| `GET` | `/api/reports/:jobId` | Download Excel report |

### Single Certificate
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/certificates/issue` | Issue one certificate (full pipeline) |
| `GET` | `/api/certificates/verify/:certId` | Verify certificate on blockchain |
| `GET` | `/api/certificates/:certId/pdf` | Generate/download PDF |

### Templates
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/templates` | List available certificate templates |
| `POST` | `/api/templates/upload` | Upload custom HTML template |
| `POST` | `/api/templates/preview` | Preview template with sample data |

### QR Codes
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/qr/:certId` | Get QR code (PNG/SVG/dataURL) |
| `POST` | `/api/qr/bulk-export` | Export multiple QR codes as ZIP |

### Email
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/email/send` | Send certificate email to one student |

## Bulk Upload Flow

### 1. Prepare CSV
```csv
studentName,studentId,degree,institution,issueDate,email
Alice Johnson,STU-2026-001,B.S. Computer Science,MIT,2026-06-15,alice@example.com
Bob Smith,STU-2026-002,MBA,Harvard,2026-06-15,bob@example.com
```

Flexible column names accepted:
- Name: `studentName`, `student_name`, `Student Name`, `name`, `fullName`
- ID: `studentId`, `student_id`, `reg number`, `matric number`
- Degree: `degree`, `program`, `programme`, `course`, `qualification`
- Institution: `institution`, `school`, `university`, `college`
- Date: `issueDate`, `issue_date`, `date`, `graduation date`
- Email: `email`, `email address`, `student email` *(optional)*

### 2. Upload & Validate
```bash
curl -X POST http://localhost:4000/api/bulk/upload \
  -F "file=@students.csv"
```

Response includes validation results, errors, and a preview.

### 3. Process Batch
```bash
curl -X POST http://localhost:4000/api/bulk/process \
  -H "Content-Type: application/json" \
  -d '{ "jobId": "xxx-xxx", "sendEmails": true }'
```

### 4. Poll Progress
```bash
curl http://localhost:4000/api/bulk/status/xxx-xxx
```

### 5. Download Results
```bash
# ZIP of all PDFs + QR codes
curl -O http://localhost:4000/api/bulk/download/xxx-xxx

# Excel report
curl -O http://localhost:4000/api/reports/xxx-xxx
```

## Custom Templates

HTML templates use **Handlebars** placeholders:

| Placeholder | Value |
|-------------|-------|
| `{{studentName}}` | Full student name |
| `{{studentId}}` | Student ID / reg number |
| `{{degree}}` | Degree or program name |
| `{{institution}}` | Issuing institution |
| `{{issueDate}}` | Raw issue date |
| `{{formatDate issueDate}}` | Formatted: "June 15, 2026" |
| `{{certId}}` | Certificate ID (CERT-2026-001-ABC) |
| `{{qrDataUrl}}` | QR code as embeddable data URL |
| `{{verifyUrl}}` | Full verification link |
| `{{currentYear}}` | Current year |

Upload your own template:
```bash
curl -X POST http://localhost:4000/api/templates/upload \
  -F "template=@my-school-certificate.html"
```

## Environment Variables

See `.env.example` for all configuration options:
- **Server**: PORT, FRONTEND_URL
- **Blockchain**: RPC_URL, CONTRACT_ADDRESS, PRIVATE_KEY
- **IPFS**: PINATA_JWT, PINATA_GATEWAY (free tier: 500 uploads/month)
- **Email**: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
- **URLs**: PUBLIC_URL, VERIFY_BASE_URL

## Tech Stack

- **Express.js** — HTTP server
- **ethers.js** — Blockchain interaction
- **Puppeteer** — HTML → PDF rendering
- **qrcode** — QR code generation
- **Nodemailer** — SMTP email delivery
- **Handlebars** — Template engine
- **Pinata** — IPFS file storage
- **archiver** — ZIP file creation
- **xlsx** — Excel report generation
- **multer** — File upload handling
# edulocka-node-express-backend
