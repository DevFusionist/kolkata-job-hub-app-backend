import logger from "../lib/logger.js";

/**
 * Request logging middleware using Pino structured logging.
 * Logs: method, path, query, sanitized body, duration, status.
 * Note: Only the LOG output is sanitized (mpin/password etc show as [REDACTED]).
 * req.body is never modified – route handlers still receive the real values.
 */
const SENSITIVE_KEYS = new Set([
  "mpin",
  "mpinhash",
  "password",
  "otp",
  "token",
  "registrationtoken",
  "mpinresettoken",
  "apikey",
  "api_key",
]);
const TRUNCATE_KEYS = new Set(["audiobase64", "audio_base64"]);
const MAX_BODY_LOG = 500;
const MAX_TRUNCATED = 80;

function sanitize(obj, depth = 0) {
  if (depth > 5) return "[max depth]";
  if (obj == null) return obj;
  if (typeof obj !== "object") return obj;

  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (SENSITIVE_KEYS.has(key)) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (TRUNCATE_KEYS.has(key) && typeof v === "string") {
      out[k] = v.length > MAX_TRUNCATED ? `[base64 ${v.length} chars]` : "[audio]";
      continue;
    }
    if (typeof v === "string" && v.length > MAX_BODY_LOG) {
      out[k] = `${v.substring(0, MAX_BODY_LOG)}... [${v.length} chars]`;
      continue;
    }
    if (typeof v === "object" && v !== null) {
      out[k] = sanitize(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function requestLogger(req, res, next) {
  const start = performance.now();
  const method = req.method;
  const path = req.originalUrl || req.url;
  const query = Object.keys(req.query || {}).length ? req.query : undefined;
  const body = req.body && Object.keys(req.body).length ? sanitize(req.body) : undefined;

  logger.info({ method, path, query, body }, "→ request");

  res.on("finish", () => {
    const duration = Math.round(performance.now() - start);
    const status = res.statusCode;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    logger[level]({ method, path, status, duration_ms: duration }, "← response");
  });

  next();
}
