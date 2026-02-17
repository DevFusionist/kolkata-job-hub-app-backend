import xss from "xss";

const xssOptions = {
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script"],
};

function sanitizeValue(val) {
  if (typeof val === "string") {
    return xss(val, xssOptions);
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (val && typeof val === "object") {
    return sanitizeObject(val);
  }
  return val;
}

function sanitizeObject(obj) {
  const cleaned = {};
  for (const [key, val] of Object.entries(obj)) {
    cleaned[key] = sanitizeValue(val);
  }
  return cleaned;
}

/**
 * Express middleware that sanitizes all string fields in req.body
 * to prevent stored XSS attacks.
 */
export function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeObject(req.body);
  }
  next();
}
