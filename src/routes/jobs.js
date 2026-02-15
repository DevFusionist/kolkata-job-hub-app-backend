import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { requireEmployer } from "../middleware/auth.js";

const router = Router();

router.post("/jobs", requireEmployer, async (req, res) => {
  const employerId = req.employerId;
  const employer = req.employer;
  const job = req.body;
  const db = getDb();
  const jobDoc = {
    ...job,
    employerId,
    employerName: employer.name,
    employerPhone: employer.phone,
    businessName: employer.businessName,
    postedDate: new Date(),
    status: "active",
    applicationsCount: 0,
  };
  if (employer.freeJobsRemaining > 0) {
    jobDoc.isPaid = false;
    await db.collection("users").updateOne(
      { _id: toObjectId(employerId) },
      { $inc: { freeJobsRemaining: -1 } }
    );
  } else {
    return res.status(402).json({ detail: "Payment required" });
  }
  const r = await db.collection("jobs").insertOne(jobDoc);
  jobDoc.id = r.insertedId.toString();
  res.json(jobDoc);
});

router.get("/jobs", async (req, res) => {
  const q = req.query;
  const db = getDb();
  const query = { status: "active" };
  if (q.category) query.category = q.category;
  if (q.location) query.location = new RegExp(q.location, "i");
  if (q.jobType) query.jobType = q.jobType;
  if (q.experience) query.experience = q.experience;
  if (q.education) query.education = q.education;
  if (q.language) query.languages = q.language;
  if (q.skill) query.skills = new RegExp(q.skill, "i");
  if (q.search) {
    query.$or = [
      { title: new RegExp(q.search, "i") },
      { description: new RegExp(q.search, "i") },
    ];
  }
  const jobs = await db.collection("jobs").find(query).sort({ postedDate: -1 }).limit(100).toArray();
  res.json(jobs.map(serializeDoc));
});

router.get("/jobs/:jobId", async (req, res) => {
  const db = getDb();
  const job = await db.collection("jobs").findOne({ _id: toObjectId(req.params.jobId) });
  if (!job) return res.status(404).json({ detail: "Job not found" });
  res.json(serializeDoc(job));
});

router.get("/jobs/employer/:employerId", async (req, res) => {
  const db = getDb();
  const jobs = await db.collection("jobs").find({ employerId: req.params.employerId }).sort({ postedDate: -1 }).limit(100).toArray();
  res.json(jobs.map(serializeDoc));
});

router.put("/jobs/:jobId/status", requireEmployer, async (req, res) => {
  const status = req.query.status || req.body?.status;
  const db = getDb();
  const r = await db.collection("jobs").updateOne(
    { _id: toObjectId(req.params.jobId), employerId: req.employerId },
    { $set: { status } }
  );
  if (r.matchedCount === 0) return res.status(404).json({ detail: "Job not found" });
  res.json({ success: true });
});

export default router;
