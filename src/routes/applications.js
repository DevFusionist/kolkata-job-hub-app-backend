import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { requireSeeker, requireEmployer } from "../middleware/auth.js";

const router = Router();

router.post("/applications", requireSeeker, async (req, res) => {
  const seekerId = req.seekerId;
  const seeker = req.seeker;
  const { jobId, coverLetter } = req.body;
  const db = getDb();
  const existing = await db.collection("applications").findOne({ jobId, seekerId });
  if (existing) return res.status(400).json({ detail: "Already applied to this job" });
  const app = {
    jobId,
    coverLetter,
    seekerId,
    seekerName: seeker.name,
    seekerPhone: seeker.phone,
    seekerSkills: seeker.skills || [],
    status: "pending",
    appliedDate: new Date(),
  };
  const r = await db.collection("applications").insertOne(app);
  app.id = r.insertedId.toString();
  await db.collection("jobs").updateOne(
    { _id: toObjectId(jobId) },
    { $inc: { applicationsCount: 1 } }
  );
  res.json(app);
});

router.get("/applications/job/:jobId", async (req, res) => {
  const db = getDb();
  const apps = await db.collection("applications").find({ jobId: req.params.jobId }).sort({ appliedDate: -1 }).limit(100).toArray();
  res.json(apps.map(serializeDoc));
});

router.get("/applications/seeker/:seekerId", async (req, res) => {
  const db = getDb();
  const apps = await db.collection("applications").find({ seekerId: req.params.seekerId }).sort({ appliedDate: -1 }).limit(100).toArray();
  res.json(apps.map(serializeDoc));
});

router.put("/applications/:appId/status", requireEmployer, async (req, res) => {
  const status = req.query.status || req.body?.status;
  const employerId = req.employerId;
  const db = getDb();
  const app = await db.collection("applications").findOne({ _id: toObjectId(req.params.appId) });
  if (!app) return res.status(404).json({ detail: "Application not found" });
  const job = await db.collection("jobs").findOne({ _id: toObjectId(app.jobId) });
  if (!job || job.employerId !== employerId) {
    return res.status(403).json({ detail: "Only the job employer can update application status" });
  }
  await db.collection("applications").updateOne(
    { _id: toObjectId(req.params.appId) },
    { $set: { status } }
  );
  res.json({ success: true });
});

export default router;
