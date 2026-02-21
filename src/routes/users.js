import { Router } from "express";
import { User } from "../models/index.js";
import { serializeDoc } from "../utils.js";
import {
  generateToken,
  invalidateUserCache,
  verifyRegistrationToken,
} from "../middleware/jwt.js";
import { requireUser } from "../middleware/auth.js";

const router = Router();
const FREE_JOB_TRIAL_LIMIT = Math.max(parseInt(process.env.FREE_JOB_TRIAL_LIMIT || "2", 10), 0);
const MAX_NAME_LEN = 100;
const MAX_BUSINESS_LEN = 120;
const MAX_LOCATION_LEN = 120;
const MAX_SKILLS = 30;
const MAX_LANGUAGES = 10;

function cleanString(v, maxLen) {
  return String(v || "").trim().slice(0, maxLen);
}

function cleanStringArray(v, { maxItems, maxItemLen }) {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, maxItems)
    .map((x) => cleanString(x, maxItemLen))
    .filter(Boolean);
}

router.post("/users", async (req, res) => {
  const body = req.body;
  const registrationToken = body.registrationToken;

  if (!registrationToken) {
    return res.status(401).json({ detail: "OTP verification required before registration" });
  }

  try {
    const decoded = verifyRegistrationToken(registrationToken);
    if (decoded.phone !== body.phone) {
      return res.status(401).json({ detail: "Phone mismatch for registration token" });
    }
  } catch {
    return res.status(401).json({ detail: "Invalid or expired registration token" });
  }

  if (!body.phone || !/^\d{10}$/.test(body.phone)) {
    return res.status(400).json({ detail: "Invalid phone number" });
  }
  const name = cleanString(body.name, MAX_NAME_LEN);
  if (!name || name.length < 2) {
    return res.status(400).json({ detail: "Name is required (min 2 characters)" });
  }
  if (!body.role || !["seeker", "employer"].includes(body.role)) {
    return res.status(400).json({ detail: "Role must be 'seeker' or 'employer'" });
  }
  const businessName = cleanString(body.businessName, MAX_BUSINESS_LEN);
  if (body.role === "employer" && (!businessName || businessName.length < 2)) {
    return res.status(400).json({ detail: "Business name required for employers" });
  }

  const location = cleanString(body.location, MAX_LOCATION_LEN);
  const skills = cleanStringArray(body.skills, { maxItems: MAX_SKILLS, maxItemLen: 60 });
  const languages = cleanStringArray(body.languages, { maxItems: MAX_LANGUAGES, maxItemLen: 40 });
  const experience = cleanString(body.experience, 40) || "Fresher";
  const education = cleanString(body.education, 60) || "";
  const industry = body.role === "employer" ? (cleanString(body.industry, 120) || null) : null;

  // Map expectedSalary (seeker) to preferredSalary { min, max }
  let preferredSalary = { min: 0, max: 0 };
  if (body.role === "seeker" && body.expectedSalary != null) {
    const num = parseInt(String(body.expectedSalary).replace(/\D/g, ""), 10);
    if (Number.isFinite(num) && num > 0) {
      preferredSalary = { min: num, max: num };
    }
  }

  const existing = await User.findOne({ phone: body.phone });
  if (existing) {
    return res.status(409).json({ detail: "Phone number already registered" });
  }

  try {
    const user = await User.create({
      phone: body.phone,
      name,
      role: body.role,
      businessName: businessName || null,
      industry: industry || null,
      location,
      skills,
      languages: languages.length ? languages : ["Bengali", "Hindi"],
      experience,
      education: education || "",
      preferredSalary,
      freeJobsRemaining: body.role === "employer" ? FREE_JOB_TRIAL_LIMIT : 0,
      paidJobsRemaining: 0,
      subscriptionPlan: "none",
      subscriptionExpiresAt: null,
    });
    const serialized = serializeDoc(user);
    const token = generateToken(serialized);
    res.json({ ...serialized, token });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ detail: "Phone number already registered" });
    }
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors).map(e => e.message).join(", ");
      return res.status(400).json({ detail: msg });
    }
    throw err;
  }
});

router.get("/users/:userId", requireUser, async (req, res) => {
  if (req.params.userId !== req.userId) {
    return res.status(403).json({ detail: "You can only view your own profile" });
  }
  try {
    const user = await User.findById(req.params.userId).lean();
    if (!user) return res.status(404).json({ detail: "User not found" });
    res.json(serializeDoc(user));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid user ID" });
    throw e;
  }
});

router.put("/users/:userId", requireUser, async (req, res) => {
  if (req.params.userId !== req.userId) {
    return res.status(403).json({ detail: "You can only update your own profile" });
  }

  try {
    const allowedFields = [
      "name",
      "businessName",
      "location",
      "skills",
      "languages",
      "experience",
      "education",
      "industry",
      "preferredLanguage",
      "preferredSalary",
    ];
    const safeFields = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        safeFields[field] = req.body[field];
      }
    }

    if (safeFields.name !== undefined) safeFields.name = cleanString(safeFields.name, MAX_NAME_LEN);
    if (safeFields.businessName !== undefined) safeFields.businessName = cleanString(safeFields.businessName, MAX_BUSINESS_LEN);
    if (safeFields.location !== undefined) safeFields.location = cleanString(safeFields.location, MAX_LOCATION_LEN);
    if (safeFields.experience !== undefined) safeFields.experience = cleanString(safeFields.experience, 40);
    if (safeFields.education !== undefined) safeFields.education = cleanString(safeFields.education, 60);
    if (safeFields.industry !== undefined) safeFields.industry = cleanString(safeFields.industry, 120) || null;
    if (safeFields.skills !== undefined) {
      safeFields.skills = cleanStringArray(safeFields.skills, { maxItems: MAX_SKILLS, maxItemLen: 60 });
    }
    if (safeFields.languages !== undefined) {
      safeFields.languages = cleanStringArray(safeFields.languages, { maxItems: MAX_LANGUAGES, maxItemLen: 40 });
    }
    if (safeFields.preferredSalary !== undefined) {
      const min = Math.max(0, parseInt(safeFields.preferredSalary?.min, 10) || 0);
      const max = Math.max(min, parseInt(safeFields.preferredSalary?.max, 10) || 0);
      safeFields.preferredSalary = { min, max };
    }

    if (Object.keys(safeFields).length === 0) {
      return res.status(400).json({ detail: "No updatable fields provided" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { $set: safeFields },
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!user) return res.status(404).json({ detail: "User not found" });
    invalidateUserCache(req.userId);
    res.json(serializeDoc(user));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid user ID" });
    if (e.name === "ValidationError") {
      const msg = Object.values(e.errors).map(v => v.message).join(", ");
      return res.status(400).json({ detail: msg });
    }
    throw e;
  }
});

export default router;
