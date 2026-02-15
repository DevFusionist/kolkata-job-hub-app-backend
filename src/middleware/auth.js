import { getDb } from "../config/db.js";
import { toObjectId } from "../utils.js";

/**
 * Require seeker_id (query or body). Validates user exists and has role "seeker".
 * Sets req.seeker on success.
 */
export async function requireSeeker(req, res, next) {
  const seekerId = req.query.seeker_id ?? req.body?.seeker_id ?? req.body?.seekerId;
  if (!seekerId) {
    return res.status(401).json({ detail: "seeker_id required (query or body)" });
  }
  try {
    const db = getDb();
    const seeker = await db.collection("users").findOne({ _id: toObjectId(seekerId) });
    if (!seeker) return res.status(404).json({ detail: "User not found" });
    if (seeker.role !== "seeker") return res.status(403).json({ detail: "Only job seekers can perform this action" });
    req.seeker = seeker;
    req.seekerId = seeker._id.toString();
    next();
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid seeker_id" });
    next(e);
  }
}

/**
 * Require employer_id (query or body). Validates user exists and has role "employer".
 * Sets req.employer on success.
 */
export async function requireEmployer(req, res, next) {
  const employerId = req.query.employer_id ?? req.body?.employer_id ?? req.body?.employerId;
  if (!employerId) {
    return res.status(401).json({ detail: "employer_id required (query or body)" });
  }
  try {
    const db = getDb();
    const employer = await db.collection("users").findOne({ _id: toObjectId(employerId) });
    if (!employer) return res.status(404).json({ detail: "Employer not found" });
    if (employer.role !== "employer") return res.status(403).json({ detail: "Only employers can perform this action" });
    req.employer = employer;
    req.employerId = employer._id.toString();
    next();
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid employer_id" });
    next(e);
  }
}

/**
 * Require any authenticated user (userId, seekerId, or employerId in body/query).
 * Sets req.user and req.userId.
 */
export async function requireUser(req, res, next) {
  const userId = req.query.user_id ?? req.query.seeker_id ?? req.query.employer_id ?? req.query.sender_id
    ?? req.body?.userId ?? req.body?.user_id ?? req.body?.seekerId ?? req.body?.seeker_id ?? req.body?.employerId ?? req.body?.employer_id ?? req.body?.senderId ?? req.body?.sender_id;
  if (!userId) {
    return res.status(401).json({ detail: "User ID required (userId, seeker_id, or employer_id)" });
  }
  try {
    const db = getDb();
    const user = await db.collection("users").findOne({ _id: toObjectId(userId) });
    if (!user) return res.status(404).json({ detail: "User not found" });
    req.user = user;
    req.userId = user._id.toString();
    next();
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid user ID" });
    next(e);
  }
}
