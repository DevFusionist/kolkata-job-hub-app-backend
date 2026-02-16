import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { requireEmployer } from "../middleware/auth.js";

const router = Router();

const VALID_CATEGORIES = [
  "Sales", "Customer Service", "Driving", "Cooking", "Computer",
  "Accounting", "Warehouse", "Delivery", "Healthcare", "Education",
  "Construction", "Hospitality", "Retail", "Manufacturing", "Other",
];
const VALID_JOB_TYPES = ["Full-time", "Part-time", "Contract", "Temporary", "Internship"];
const VALID_EXPERIENCE = ["Fresher", "1-2 years", "3-5 years", "5+ years"];
const VALID_EDUCATION = ["None", "10th Pass", "12th Pass", "Graduate", "Post Graduate"];

router.post("/jobs", requireEmployer, async (req, res) => {
  const employerId = req.employerId;
  const employer = req.employer;
  const { title, category, description, salary, location, jobType, experience, education, languages, skills } = req.body;

  // Validation
  if (!title || title.trim().length < 3 || title.trim().length > 100) {
    return res.status(400).json({ detail: "Title required (3-100 characters)" });
  }
  if (!category || !VALID_CATEGORIES.includes(category)) {
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
  if (!jobType || !VALID_JOB_TYPES.includes(jobType)) {
    return res.status(400).json({ detail: "Valid job type required" });
  }
  if (!experience || !VALID_EXPERIENCE.includes(experience)) {
    return res.status(400).json({ detail: "Valid experience level required" });
  }
  if (!education || !VALID_EDUCATION.includes(education)) {
    return res.status(400).json({ detail: "Valid education level required" });
  }
  if (!languages || !Array.isArray(languages) || languages.length === 0) {
    return res.status(400).json({ detail: "At least one language required" });
  }
  if (!skills || !Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ detail: "At least one skill required" });
  }

  const db = getDb();

  if (employer.freeJobsRemaining > 0) {
    const jobDoc = {
      title: title.trim(),
      category,
      description: description.trim(),
      salary: salary.trim(),
      location: location.trim(),
      jobType,
      experience,
      education,
      languages,
      skills,
      employerId,
      employerName: employer.name,
      employerPhone: employer.phone,
      businessName: employer.businessName,
      postedDate: new Date(),
      status: "active",
      applicationsCount: 0,
      isPaid: false,
    };

    const r = await db.collection("jobs").insertOne(jobDoc);
    // Only decrement AFTER successful insert
    await db.collection("users").updateOne(
      { _id: toObjectId(employerId) },
      { $inc: { freeJobsRemaining: -1 } }
    );
    jobDoc.id = r.insertedId.toString();
    res.json(jobDoc);
  } else {
    return res.status(402).json({ detail: "Payment required" });
  }
});

router.get("/jobs", async (req, res) => {
  const q = req.query;
  const db = getDb();
  const query = { status: "active" };
  if (q.category) query.category = q.category;
  if (q.location) {
    // Escape regex special chars to prevent ReDoS
    const escaped = q.location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.location = new RegExp(escaped, "i");
  }
  if (q.jobType) query.jobType = q.jobType;
  if (q.experience) query.experience = q.experience;
  if (q.education) query.education = q.education;
  if (q.language) query.languages = q.language;
  if (q.skill) {
    const escaped = q.skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.skills = new RegExp(escaped, "i");
  }
  if (q.search) {
    const escaped = q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { title: new RegExp(escaped, "i") },
      { description: new RegExp(escaped, "i") },
    ];
  }
  const jobs = await db.collection("jobs").find(query).sort({ postedDate: -1 }).limit(100).toArray();
  res.json(jobs.map(serializeDoc));
});

router.get("/jobs/:jobId", async (req, res) => {
  try {
    const db = getDb();
    const job = await db.collection("jobs").findOne({ _id: toObjectId(req.params.jobId) });
    if (!job) return res.status(404).json({ detail: "Job not found" });
    res.json(serializeDoc(job));
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid job ID" });
    throw e;
  }
});

router.get("/jobs/employer/:employerId", async (req, res) => {
  const db = getDb();
  try {
    const jobs = await db.collection("jobs").find({ employerId: req.params.employerId }).sort({ postedDate: -1 }).limit(100).toArray();
    res.json(jobs.map(serializeDoc));
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid employer ID" });
    throw e;
  }
});

router.put("/jobs/:jobId/status", requireEmployer, async (req, res) => {
  const status = req.query.status || req.body?.status;
  if (!status || !["active", "closed", "paused"].includes(status)) {
    return res.status(400).json({ detail: "Valid status required (active, closed, paused)" });
  }
  try {
    const db = getDb();
    const r = await db.collection("jobs").updateOne(
      { _id: toObjectId(req.params.jobId), employerId: req.employerId },
      { $set: { status } }
    );
    if (r.matchedCount === 0) return res.status(404).json({ detail: "Job not found or not owned by you" });
    res.json({ success: true });
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid job ID" });
    throw e;
  }
});

export default router;
