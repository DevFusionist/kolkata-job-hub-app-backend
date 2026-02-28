import { Router } from "express";
import { Job, CATEGORIES, JOB_TYPES, EXPERIENCE_LEVELS, EDUCATION_LEVELS } from "../models/index.js";
import { serializeDoc } from "../utils.js";
import { requireEmployer } from "../middleware/auth.js";
import { invalidateUserCache } from "../middleware/jwt.js";
import { reserveJobPostingQuota, rollbackJobPostingQuota } from "../lib/employerEntitlements.js";

const router = Router();
const JOB_LIST_PROJECTION = "title category description salary salaryMin salaryMax location jobType experience education languages skills employerId employerName businessName postedDate status applicationsCount isPaid createdAt updatedAt";

function sanitizeJobResponse(job, { includeEmployerPhone = false } = {}) {
  const out = serializeDoc(job);
  if (!includeEmployerPhone) delete out.employerPhone;
  return out;
}

function parseSalaryRange(salary) {
  const nums = salary.match(/\d+/g);
  if (!nums || nums.length === 0) return { salaryMin: 0, salaryMax: 0 };
  const parsed = nums.map(Number);
  return {
    salaryMin: parsed[0] || 0,
    salaryMax: parsed[1] || parsed[0] || 0,
  };
}

router.post("/jobs", requireEmployer, async (req, res) => {
  const employerId = req.employerId;
  const { title, category, description, salary, location, jobType, experience, education, languages, skills } = req.body;

  if (!title || title.trim().length < 3 || title.trim().length > 100) {
    return res.status(400).json({ detail: "Title required (3-100 characters)" });
  }
  if (!category || !CATEGORIES.includes(category)) {
    return res.status(400).json({ detail: "Valid category required" });
  }
  if (!description || description.trim().length < 10 || description.trim().length > 2000) {
    return res.status(400).json({ detail: "Description required (10-2000 characters)" });
  }
  if (!salary || salary.trim().length < 2) {
    return res.status(400).json({ detail: "Salary required" });
  }
  if (!location || location.trim().length < 2) {
    return res.status(400).json({ detail: "Location required" });
  }
  if (!jobType || !JOB_TYPES.includes(jobType)) {
    return res.status(400).json({ detail: "Valid job type required" });
  }
  if (!experience || !EXPERIENCE_LEVELS.includes(experience)) {
    return res.status(400).json({ detail: "Valid experience level required" });
  }
  if (education && !EDUCATION_LEVELS.includes(education)) {
    return res.status(400).json({ detail: "Valid education level required" });
  }
  if (!languages || !Array.isArray(languages) || languages.length === 0) {
    return res.status(400).json({ detail: "At least one language required" });
  }
  if (!skills || !Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ detail: "At least one skill required" });
  }

  const reservation = await reserveJobPostingQuota(employerId);
  if (!reservation.ok) {
    return res.status(402).json({ detail: "Payment required" });
  }
  const employer = reservation.user;

  const { salaryMin, salaryMax } = parseSalaryRange(salary);

  try {
    const job = await Job.create({
      title: title.trim(),
      category,
      description: description.trim(),
      salary: salary.trim(),
      salaryMin,
      salaryMax,
      location: location.trim(),
      jobType,
      experience,
      education: education || "Any",
      languages,
      skills,
      employerId,
      employerName: employer.name,
      employerPhone: employer.phone,
      businessName: employer.businessName,
      postedDate: new Date(),
      status: "active",
      applicationsCount: 0,
      isPaid: reservation.source !== "free",
    });

    invalidateUserCache(employerId);

    res.json(sanitizeJobResponse(job, { includeEmployerPhone: true }));
  } catch (err) {
    await rollbackJobPostingQuota(employerId, reservation.source);
    invalidateUserCache(employerId);
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors).map(e => e.message).join(", ");
      return res.status(400).json({ detail: msg });
    }
    throw err;
  }
});

router.get("/jobs", async (req, res) => {
  const q = req.query;
  const filter = { status: "active" };
  let sort = { postedDate: -1 };
  const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || "50"), 10) || 50));
  if (q.category) filter.category = q.category;
  if (q.location) {
    const escaped = q.location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.location = new RegExp(escaped, "i");
  }
  if (q.jobType) filter.jobType = q.jobType;
  if (q.experience) filter.experience = q.experience;
  if (q.education) filter.education = q.education;
  if (q.language) filter.languages = q.language;
  if (q.skill) {
    const escaped = q.skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.skills = new RegExp(escaped, "i");
  }
  if (q.search) {
    filter.$text = { $search: String(q.search) };
    sort = { score: { $meta: "textScore" }, postedDate: -1 };
  }
  let jobs = await Job.find(filter)
    .select(q.search ? { ...Object.fromEntries(JOB_LIST_PROJECTION.split(" ").map((f) => [f, 1])), score: { $meta: "textScore" } } : JOB_LIST_PROJECTION)
    .sort(sort)
    .limit(limit)
    .lean();

  if (!jobs.length && q.search) {
    // Fallback for fuzzy substring behavior when text index returns nothing.
    const escaped = String(q.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fallbackFilter = {
      ...filter,
      $or: [{ title: new RegExp(escaped, "i") }, { description: new RegExp(escaped, "i") }],
    };
    delete fallbackFilter.$text;
    jobs = await Job.find(fallbackFilter).select(JOB_LIST_PROJECTION).sort({ postedDate: -1 }).limit(limit).lean();
  }
  res.json(jobs.map((j) => sanitizeJobResponse(j)));
});

router.get("/jobs/:jobId", async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId).lean();
    if (!job) return res.status(404).json({ detail: "Job not found" });
    const includeEmployerPhone = req.userRole === "employer" && req.userId === job.employerId;
    res.json(sanitizeJobResponse(job, { includeEmployerPhone }));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid job ID" });
    throw e;
  }
});

router.get("/jobs/employer/:employerId", requireEmployer, async (req, res) => {
  if (req.params.employerId !== req.employerId) {
    return res.status(403).json({ detail: "You can only view your own jobs" });
  }
  try {
    const jobs = await Job.find({ employerId: req.params.employerId })
      .select(JOB_LIST_PROJECTION)
      .sort({ postedDate: -1 })
      .limit(100)
      .lean();
    res.json(jobs.map((j) => sanitizeJobResponse(j, { includeEmployerPhone: true })));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid employer ID" });
    throw e;
  }
});

router.put("/jobs/:jobId/status", requireEmployer, async (req, res) => {
  const status = req.query.status || req.body?.status;
  if (!status || !["active", "closed", "paused"].includes(status)) {
    return res.status(400).json({ detail: "Valid status required (active, closed, paused)" });
  }
  try {
    const job = await Job.findOneAndUpdate(
      { _id: req.params.jobId, employerId: req.employerId },
      { $set: { status } },
      { returnDocument: "after" }
    );
    if (!job) return res.status(404).json({ detail: "Job not found or not owned by you" });
    res.json({ success: true });
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid job ID" });
    throw e;
  }
});

export default router;
