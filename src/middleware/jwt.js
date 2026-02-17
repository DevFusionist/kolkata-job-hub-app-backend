import jwt from "jsonwebtoken";
import { User } from "../models/index.js";

const JWT_SECRET = process.env.JWT_SECRET || "kolkata-job-hub-fallback-secret";
const JWT_EXPIRES_IN = "30d";

// In-memory TTL cache for User lookups to avoid DB hit on every request
const USER_CACHE_TTL_MS = 60_000; // 60 seconds
const userCache = new Map(); // userId -> { user, expiresAt }

function getCachedUser(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    userCache.delete(userId);
    return null;
  }
  return entry.user;
}

function setCachedUser(userId, user) {
  userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  // Evict stale entries periodically (keep cache bounded)
  if (userCache.size > 5000) {
    const now = Date.now();
    for (const [key, val] of userCache) {
      if (now > val.expiresAt) userCache.delete(key);
    }
  }
}

/**
 * Generate a JWT for a user.
 * @param {{ id: string, phone: string, role: string }} user
 */
export function generateToken(user) {
  return jwt.sign(
    { userId: user.id, phone: user.phone, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Express middleware: verifies JWT from Authorization header.
 * Sets req.userId, req.userRole, and req.user (full doc from DB).
 * If no token present, silently passes through (requireUser etc. will reject).
 */
export async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Try cache first
    let user = getCachedUser(decoded.userId);
    if (!user) {
      user = await User.findById(decoded.userId).lean();
      if (!user) {
        return res.status(401).json({ detail: "User not found" });
      }
      setCachedUser(decoded.userId, user);
    }

    req.userId = user._id.toString();
    req.userRole = user.role;
    req.user = user;

    if (user.role === "seeker") {
      req.seeker = user;
      req.seekerId = req.userId;
    } else if (user.role === "employer") {
      req.employer = user;
      req.employerId = req.userId;
    }
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ detail: "Token expired" });
    }
    return res.status(401).json({ detail: "Invalid token" });
  }
}
