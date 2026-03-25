const path = require("path");
const swaggerJSDoc = require("swagger-jsdoc");

function buildOpenApiSpec() {
  const definition = {
    openapi: "3.0.3",
    info: {
      title: "Edulocka API",
      version: "1.0.0",
      description:
        "Backend API for Edulocka (blogs, certificate issuance, templates, institution applications, admin).",
    },
    servers: [
      {
        url: process.env.PUBLIC_API_BASE_URL || "http://localhost:4000",
        description: "API server",
      },
    ],
    components: {
      securitySchemes: {
        WalletAddress: {
          type: "apiKey",
          in: "header",
          name: "x-wallet-address",
          description: "Wallet address header (some GET endpoints accept address without signature).",
        },
        WalletSignature: {
          type: "apiKey",
          in: "header",
          name: "x-wallet-signature",
          description: "Signature of x-wallet-message.",
        },
        WalletMessage: {
          type: "apiKey",
          in: "header",
          name: "x-wallet-message",
          description: "Signed message, e.g. 'Edulocka Auth: <timestamp>'.",
        },
        AdminWallet: {
          type: "apiKey",
          in: "header",
          name: "x-wallet-address",
          description: "Admin wallet address (must match ADMIN_WALLET_ADDRESS).",
        },
      },
    },
    tags: [
      { name: "Health", description: "Service health" },
      { name: "Blogs", description: "Blog feed + writer workflow" },
      { name: "Templates", description: "Certificate templates" },
      { name: "Certificates", description: "Issue and verify certificates" },
      { name: "Bulk", description: "Bulk issuance jobs" },
      { name: "Institutions", description: "Institution applications" },
      { name: "Admin", description: "Admin dashboard operations" },
    ],
  };

  return swaggerJSDoc({
    definition,
    apis: [
      path.join(__dirname, "..", "server.js"),
      path.join(__dirname, "..", "routes", "*.js"),
    ],
  });
}

module.exports = { buildOpenApiSpec };

