import jwt from "jsonwebtoken";
import { getDb } from "../config/db.js";
import { toObjectId } from "../utils.js";

const JWT_SECRET = process.env.JWT_SECRET || "kolkata-job-hub-fallback-secret";
const JWT_EXPIRES_IN = "30d";

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
 * Falls back to legacy query-param auth if no token present (backward compat).
 */
export async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // Backward compat: fall through to legacy auth middleware
    return next();
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = await db
      .collection("users")
      .findOne({ _id: toObjectId(decoded.userId) });
    if (!user) {
      return res.status(401).json({ detail: "User not found" });
    }
    req.userId = user._id.toString();
    req.userRole = user.role;
    req.user = user;

    // Also set req.seeker / req.employer for compatibility with existing middleware
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
