import { Router } from "express";
import { Application, Job } from "../models/index.js";
import { serializeDoc } from "../utils.js";
import { requireSeeker, requireEmployer } from "../middleware/auth.js";

const router = Router();

router.post("/applications", requireSeeker, async (req, res) => {
  const seekerId = req.seekerId;
  const seeker = req.seeker;
  const { jobId, coverLetter } = req.body;

  if (!jobId) {
    return res.status(400).json({ detail: "jobId is required" });
  }
  if (coverLetter && coverLetter.length > 2000) {
    return res.status(400).json({ detail: "Cover letter too long (max 2000 characters)" });
  }

  try {
    const job = await Job.findById(jobId).select("_id status").lean();
    if (!job) return res.status(404).json({ detail: "Job not found" });
    if (job.status !== "active") return res.status(400).json({ detail: "Job is no longer accepting applications" });

    const application = await Application.create({
      job: jobId,
      seeker: seekerId,
      seekerName: seeker.name,
      seekerPhone: seeker.phone,
      seekerSkills: seeker.skills || [],
      coverLetter: coverLetter || "",
      status: "pending",
      appliedDate: new Date(),
    });

    await Job.updateOne({ _id: jobId }, { $inc: { applicationsCount: 1 } });

    res.json(application.toJSON());
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid jobId format" });
    if (e.code === 11000) return res.status(400).json({ detail: "Already applied to this job" });
    throw e;
  }
});

router.get("/applications/job/:jobId", requireEmployer, async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId).lean();
    if (!job) return res.status(404).json({ detail: "Job not found" });
    if (job.employerId !== req.employerId) {
      return res.status(403).json({ detail: "You can only view applications for your own jobs" });
    }

    const apps = await Application.find({ job: req.params.jobId })
      .select("job seeker seekerName seekerPhone seekerSkills coverLetter status appliedDate createdAt updatedAt")
      .sort({ appliedDate: -1 })
      .limit(100)
      .lean();
    res.json(apps.map(serializeDoc));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid jobId format" });
    throw e;
  }
});

router.get("/applications/seeker/:seekerId", requireSeeker, async (req, res) => {
  if (req.params.seekerId !== req.seekerId) {
    return res.status(403).json({ detail: "You can only view your own applications" });
  }
  try {
    const apps = await Application.find({ seeker: req.params.seekerId })
      .select("job seeker seekerName seekerPhone seekerSkills coverLetter status appliedDate createdAt updatedAt")
      .sort({ appliedDate: -1 })
      .limit(100)
      .lean();
    res.json(apps.map(serializeDoc));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid seekerId format" });
    throw e;
  }
});

router.put("/applications/:appId/status", requireEmployer, async (req, res) => {
  const status = req.query.status || req.body?.status;
  if (!status || !["shortlisted", "rejected", "hired"].includes(status)) {
    return res.status(400).json({ detail: "Valid status required (shortlisted, rejected, hired)" });
  }
  try {
    const app = await Application.findById(req.params.appId);
    if (!app) return res.status(404).json({ detail: "Application not found" });

    const job = await Job.findById(app.job);
    if (!job || job.employerId !== req.employerId) {
      return res.status(403).json({ detail: "Only the job employer can update application status" });
    }
    app.status = status;
    await app.save();
    res.json({ success: true });
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid application ID" });
    throw e;
  }
});

export default router;
