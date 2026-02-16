import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { requireSeeker, requireUser } from "../middleware/auth.js";
import { analyzePortfolio, rankJobsForSeeker, rankCandidatesForJob } from "../services/ai.js";
import { handleProtibhaChat } from "../services/protibhaChat.js";

const router = Router();

/**
 * Unified Protibha chat – single AI entry point for job search, apply, create job.
 * Requires: userId (or seeker_id/employer_id) in query/body.
 * Body: { messages: [{ role, content }], jobDraft?: {...} }
 */
router.post("/ai/chat", requireUser, async (req, res) => {
  const userId = req.userId;
  const user = req.user;
  const { messages = [], jobDraft = null, lastJobs = [] } = req.body;
  try {
    const result = await handleProtibhaChat(userId, user.role, messages, jobDraft, { lastJobs });
    res.json(result);
  } catch (e) {
    console.error("Protibha chat error:", e);
    res.status(500).json({
      message: "Something went wrong. Please try again.",
      action: "error",
    });
  }
});

router.post("/ai/analyze-portfolio", requireSeeker, async (req, res) => {
  const seekerId = req.seekerId;
  const user = req.seeker;
  const { rawText, projects = [], links = [] } = req.body;
  const db = getDb();
  const result = await analyzePortfolio(rawText, projects, links);
  const aiExtracted = {
    skills: result.skills,
    experience: result.experience,
    category: result.category,
    score: result.score,
  };
  await db.collection("portfolios").insertOne({
    seekerId,
    rawText,
    projects,
    links,
    aiExtracted,
    createdAt: new Date(),
  });
  const existingSkills = new Set(user.skills || []);
  for (const s of result.skills) {
    if (s && !existingSkills.has(s)) existingSkills.add(s);
  }
  await db.collection("users").updateOne(
    { _id: toObjectId(seekerId) },
    { $set: { aiExtracted, skills: [...existingSkills].slice(0, 30) } }
  );
  await db.collection("ai_extracted_data").insertOne({
    type: "portfolio_analysis",
    seekerId,
    skills: result.skills,
    category: result.category,
    score: result.score,
    createdAt: new Date(),
  });
  res.json({
    skills: result.skills,
    experience: result.experience,
    category: result.category,
    score: result.score,
    feedback: result.feedback,
  });
});

/** Match: seekerId → jobs for seeker; jobId → candidates for employer */
router.post("/ai/match", async (req, res) => {
  const { seekerId, jobId, limit = 5 } = req.body;
  if (seekerId && jobId) return res.status(400).json({ detail: "Provide seekerId or jobId, not both" });
  if (!seekerId && !jobId) return res.status(400).json({ detail: "Provide seekerId or jobId" });
  const lim = Math.min(limit || 10, 20);
  const db = getDb();

  if (seekerId) {
    const seeker = await db.collection("users").findOne({ _id: toObjectId(seekerId) });
    if (!seeker || seeker.role !== "seeker") return res.json({ jobs: [] });
    const skills = seeker.skills || [];
    const aiSkills = seeker.aiExtracted?.skills || [];
    const allSkills = [...new Set([...skills, ...aiSkills])];
    const query = { status: "active" };
    if (allSkills.length) {
      const skillRegex = allSkills.slice(0, 8).filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      if (skillRegex) {
        query.$or = [
          { skills: { $in: allSkills } },
          { category: new RegExp(skillRegex, "i") },
          { title: new RegExp(skillRegex, "i") },
        ];
      }
    }
    const jobsRaw = await db.collection("jobs").find(query).sort({ postedDate: -1 }).limit(30).toArray();
    if (!jobsRaw.length) return res.json({ jobs: [] });
    for (const j of jobsRaw) j.id = j._id.toString();
    const rankedIds = await rankJobsForSeeker(seeker, jobsRaw, lim);
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j._id.toString(), j]));
    const jobsOrdered = rankedIds.map((id) => idToJob[id]).filter(Boolean);
    return res.json({ jobs: jobsOrdered.map(serializeDoc) });
  }

  const job = await db.collection("jobs").findOne({ _id: toObjectId(jobId) });
  if (!job) return res.status(404).json({ detail: "Job not found" });
  const jobSkills = job.skills || [];
  const query = { role: "seeker" };
  if (jobSkills.length) {
    query.$or = [
      { skills: { $in: jobSkills } },
      { "aiExtracted.skills": { $in: jobSkills } },
    ];
  }
  const seekersRaw = await db.collection("users").find(query).limit(30).toArray();
  if (!seekersRaw.length) return res.json({ candidates: [] });
  for (const s of seekersRaw) s.id = s._id.toString();
  const rankedIds = await rankCandidatesForJob(job, seekersRaw, lim);
  const idToSeeker = Object.fromEntries(seekersRaw.map((s) => [s._id.toString(), s]));
  const seekersOrdered = rankedIds.map((id) => idToSeeker[id]).filter(Boolean);
  res.json({ candidates: seekersOrdered.map(serializeDoc) });
});

export default router;
