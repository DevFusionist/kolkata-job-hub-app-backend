/**
 * Request logging middleware.
 * Logs: method, path, query, sanitized body, duration, status, response summary.
 * Note: Only the LOG output is sanitized (mpin/password etc show as [REDACTED]).
 * req.body is never modified – route handlers still receive the real values.
 */
const SENSITIVE_KEYS = new Set(["mpin", "mpinHash", "password", "otp", "token", "apiKey", "api_key"]);
const TRUNCATE_KEYS = new Set(["audiobase64", "audio_base64"]); // truncate base64 audio in logs
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

function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function timestamp() {
  return new Date().toISOString();
}

export function requestLogger(req, res, next) {
  const start = performance.now();
  const method = req.method;
  const path = req.originalUrl || req.url;
  const query = Object.keys(req.query || {}).length ? req.query : undefined;
  const body = req.body && Object.keys(req.body).length ? sanitize(req.body) : undefined;

  const logLine = [];
  logLine.push(`[${timestamp()}] → ${method} ${path}`);
  if (query) logLine.push(`  query: ${JSON.stringify(query)}`);
  if (body) logLine.push(`  body: ${JSON.stringify(body)}`);
  console.log(logLine.join("\n"));

  const logResponse = (payload) => {
    if (res._requestLogged) return;
    res._requestLogged = true;
    const duration = performance.now() - start;
    const status = res.statusCode;
    const summary = sanitizePayloadSummary(payload);
    console.log(
      `[${timestamp()}] ← ${method} ${path} | ${status} | ${formatDuration(duration)} | ${summary}`
    );
  };

  const originalJson = res.json.bind(res);
  res.json = function (payload) {
    logResponse(payload);
    return originalJson(payload);
  };

  const originalSend = res.send.bind(res);
  res.send = function (payload) {
    const parsed = typeof payload === "string" ? tryParse(payload) : payload;
    logResponse(parsed);
    return originalSend(payload);
  };

  res.on("finish", () => {
    if (!res._requestLogged) {
      const duration = performance.now() - start;
      console.log(`[${timestamp()}] ← ${method} ${path} | ${res.statusCode} | ${formatDuration(duration)} | [sent]`);
    }
  });

  next();
}

function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str?.length > 100 ? `${str.slice(0, 100)}...` : str;
  }
}

function sanitizePayloadSummary(payload) {
  if (payload == null) return "null";
  if (typeof payload !== "object") return String(payload).slice(0, 100);
  const keys = Object.keys(payload);
  if (keys.length === 0) return "{}";
  const parts = keys.map((k) => {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) return `${k}: [REDACTED]`;
    const v = payload[k];
    if (Array.isArray(v)) return `${k}: [${v.length} items]`;
    if (typeof v === "object" && v !== null) return `${k}: {...}`;
    if (typeof v === "string" && v.length > 60) return `${k}: "${v.slice(0, 60)}..."`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  return parts.join(", ");
}
