// ============================================================================
// AI Template Service — Gemini-powered certificate template generation
// ============================================================================

const DEFAULT_MODEL = "gemini-flash-latest";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_RETRY_DELAYS_MS = [1200, 3000, 6500];

const REQUIRED_PLACEHOLDERS = [
  "{{studentName}}",
  "{{degree}}",
  "{{institution}}",
  "{{issueDate}}",
  "{{certId}}",
  "{{qrDataUrl}}",
  "{{verifyUrl}}",
];

function getGeminiConfig() {
  const apiKey = process.env.GEMINI_KEY;
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbackModels = String(process.env.GEMINI_FALLBACK_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const baseUrl = (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  if (!apiKey) {
    throw new Error("Gemini is not configured. Set GEMINI_KEY in the backend environment.");
  }

  return { apiKey, model, fallbackModels, baseUrl };
}

class GeminiServiceError extends Error {
  constructor(message, { statusCode = 502, retryable = false, model = null } = {}) {
    super(message);
    this.name = "GeminiServiceError";
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.model = model;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(status, message) {
  const normalized = String(message || "").toLowerCase();
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    normalized.includes("high demand") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("try again later") ||
    normalized.includes("rate limit")
  );
}

function toFriendlyGeminiMessage(message) {
  const normalized = String(message || "").toLowerCase();
  if (
    normalized.includes("high demand") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("try again later")
  ) {
    return "Gemini is temporarily overloaded. Please try the AI edit again in a moment.";
  }

  if (normalized.includes("rate limit") || normalized.includes("quota")) {
    return "Gemini rate limits were reached. Please wait a moment and try again.";
  }

  return message || "Gemini could not complete the template request.";
}

function stripCodeFence(text) {
  return text
    .replace(/^```(?:html|json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractHtml(rawText) {
  const cleaned = stripCodeFence(String(rawText || ""));

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.html === "string") {
      return stripCodeFence(parsed.html);
    }
  } catch {
    // Gemini may return plain HTML, which is fine.
  }

  const htmlMatch = cleaned.match(/<!doctype html>[\s\S]*<\/html>/i) || cleaned.match(/<html[\s\S]*<\/html>/i);
  return stripCodeFence(htmlMatch ? htmlMatch[0] : cleaned);
}

function sanitizeGeneratedHtml(html) {
  return String(html || "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");
}

function ensureTemplateContract(html) {
  let result = html;

  if (!/<html[\s>]/i.test(result)) {
    result = `<!doctype html><html><head><meta charset="utf-8" /></head><body>${result}</body></html>`;
  }

  const missing = REQUIRED_PLACEHOLDERS.filter((placeholder) => !result.includes(placeholder));
  if (missing.length > 0) {
    const fallbackBlock = `
  <section class="edulocka-required-fields" style="margin:24px auto 0;max-width:760px;border:2px solid #2563eb;padding:18px;font-family:Arial,sans-serif;color:#0f172a;background:#f8fafc;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#2563eb;">Verified Certificate Details</div>
    ${missing.includes("{{studentName}}") ? '<div style="margin-top:8px;font-size:24px;font-weight:800;">{{studentName}}</div>' : ""}
    ${missing.includes("{{degree}}") ? '<div style="margin-top:4px;font-size:16px;">{{degree}}</div>' : ""}
    ${missing.includes("{{institution}}") ? '<div style="margin-top:4px;font-size:14px;">{{institution}}</div>' : ""}
    ${missing.includes("{{issueDate}}") ? '<div style="margin-top:4px;font-size:12px;">Issued: {{issueDate}}</div>' : ""}
    ${missing.includes("{{certId}}") ? '<div style="margin-top:4px;font-size:12px;">Certificate ID: {{certId}}</div>' : ""}
    ${
      missing.includes("{{qrDataUrl}}")
        ? '<img src="{{qrDataUrl}}" alt="Verification QR" style="margin-top:12px;width:96px;height:96px;" />'
        : ""
    }
    ${
      missing.includes("{{verifyUrl}}")
        ? '<div style="margin-top:6px;font-size:11px;"><a href="{{verifyUrl}}" style="color:#2563eb;">{{verifyUrl}}</a></div>'
        : ""
    }
  </section>
`;

    if (/<\/body>/i.test(result)) {
      result = result.replace(/<\/body>/i, `${fallbackBlock}</body>`);
    } else {
      result += fallbackBlock;
    }
  }

  return result;
}

function buildPrompt({ prompt, institutionName, tone, colorPalette }) {
  return `
You are designing a production-ready HTML certificate template for Edulocka.

Return ONLY valid HTML. Do not include Markdown fences, explanations, or external assets.

Template requirements:
- Must be a complete HTML document with embedded CSS.
- Must be suitable for PDF rendering at A4 landscape.
- Must use Handlebars placeholders exactly where certificate data belongs.
- Required placeholders: ${REQUIRED_PLACEHOLDERS.join(", ")}.
- Optional placeholders allowed: {{studentId}}, {{ipfsHash}}, {{currentYear}}, {{generatedAt}}.
- Put the QR image with src="{{qrDataUrl}}" and include a verification link with href="{{verifyUrl}}".
- Do not include scripts, form fields, iframes, remote fonts, remote images, or tracking pixels.
- Use a polished Web3 academic style: precise borders, strong typography, subtle blockchain/security cues, and professional spacing.
- Keep text readable when rendered as a PDF.

Institution context:
- Institution name: ${institutionName || "{{institution}}"}
- Tone: ${tone || "prestigious, modern, trusted"}
- Preferred palette: ${colorPalette || "deep navy, electric blue, emerald accents, white"}

User request:
${prompt}
`.trim();
}

function buildEditPrompt({ prompt, existingHtml }) {
  return `
You are improving an existing Edulocka certificate HTML template.

Return ONLY the complete updated HTML document. Do not include Markdown fences or explanations.

Keep these production constraints:
- Preserve all existing Handlebars placeholders unless explicitly impossible.
- Required placeholders must exist: ${REQUIRED_PLACEHOLDERS.join(", ")}.
- Keep src="{{qrDataUrl}}" for the QR code and href="{{verifyUrl}}" for verification.
- Do not include scripts, form fields, iframes, remote fonts, remote images, or tracking pixels.
- Keep the template suitable for A4 landscape PDF rendering.
- Apply the requested edits while preserving the certificate's core purpose.

Requested edit:
${prompt}

Existing template:
${existingHtml}
`.trim();
}

async function requestGeminiContent({ apiKey, baseUrl, model, prompt }) {
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.72,
        topP: 0.92,
        maxOutputTokens: 8192,
      },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error?.message || `Gemini request failed with HTTP ${res.status}`;
    const retryable = isRetryableGeminiError(res.status, message);
    throw new GeminiServiceError(message, {
      statusCode: retryable ? 503 : res.status,
      retryable,
      model,
    });
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new GeminiServiceError("Gemini did not return template HTML.", {
      statusCode: 502,
      retryable: true,
      model,
    });
  }

  return text;
}

async function callGemini(prompt) {
  const { apiKey, model, fallbackModels, baseUrl } = getGeminiConfig();
  const models = [model, ...fallbackModels.filter((fallback) => fallback !== model)];
  let lastError = null;

  for (const candidateModel of models) {
    for (let attempt = 0; attempt <= DEFAULT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await requestGeminiContent({
          apiKey,
          baseUrl,
          model: candidateModel,
          prompt,
        });
      } catch (err) {
        lastError = err;
        const retryable = err instanceof GeminiServiceError && err.retryable;
        const hasRetry = attempt < DEFAULT_RETRY_DELAYS_MS.length;

        if (!retryable) {
          throw err;
        }

        if (hasRetry) {
          await sleep(DEFAULT_RETRY_DELAYS_MS[attempt]);
          continue;
        }

        break;
      }
    }
  }

  const message = toFriendlyGeminiMessage(lastError?.message);
  throw new GeminiServiceError(message, {
    statusCode: lastError?.statusCode || 503,
    retryable: true,
    model: lastError?.model || model,
  });
}

async function generateCertificateTemplate(options) {
  const prompt = buildPrompt(options);
  const rawText = await callGemini(prompt);
  const html = ensureTemplateContract(sanitizeGeneratedHtml(extractHtml(rawText)));

  return {
    html,
    placeholders: REQUIRED_PLACEHOLDERS,
  };
}

async function editCertificateTemplate(options) {
  const prompt = buildEditPrompt(options);
  const rawText = await callGemini(prompt);
  const html = ensureTemplateContract(sanitizeGeneratedHtml(extractHtml(rawText)));

  return {
    html,
    placeholders: REQUIRED_PLACEHOLDERS,
  };
}

module.exports = {
  editCertificateTemplate,
  generateCertificateTemplate,
  GeminiServiceError,
  REQUIRED_PLACEHOLDERS,
};
