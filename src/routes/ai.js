import { Router } from "express";
import { User, Job, Portfolio, ChatSession } from "../models/index.js";
import { serializeDoc } from "../utils.js";
import { requireSeeker, requireUser } from "../middleware/auth.js";
import { invalidateUserCache } from "../middleware/jwt.js";
import { analyzePortfolio, rankJobsForSeeker, rankCandidatesForJob } from "../services/ai.js";
import { handleProtibhaChat } from "../services/protibhaChat.js";
import logger from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();
const MAX_CHAT_MESSAGES = 40;
const MAX_CHAT_MESSAGE_CHARS = 500;
const MAX_JOB_DRAFT_FIELD_CHARS = 300;
const MAX_LAST_JOBS = 30;
const MAX_PORTFOLIO_TEXT = 8000;
const MAX_PROJECTS = 20;
const MAX_LINKS = 20;
const MAX_LINK_CHARS = 200;
const MAX_PROJECT_FIELD_CHARS = 200;

function sanitizeJob(job) {
  const out = serializeDoc(job);
  delete out.employerPhone;
  return out;
}

function sanitizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-MAX_CHAT_MESSAGES)
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.content || "").slice(0, MAX_CHAT_MESSAGE_CHARS).trim(),
    }))
    .filter((m) => m.content.length > 0);
}

function sanitizeJobDraft(jobDraft) {
  if (!jobDraft || typeof jobDraft !== "object") return null;
  const fields = ["category", "location", "salary", "jobType", "experience", "description"];
  const out = {};
  for (const f of fields) {
    if (jobDraft[f] !== undefined) out[f] = String(jobDraft[f] || "").slice(0, MAX_JOB_DRAFT_FIELD_CHARS);
  }
  return out;
}

function sanitizeLastJobs(lastJobs) {
  if (!Array.isArray(lastJobs)) return [];
  return lastJobs
    .slice(0, MAX_LAST_JOBS)
    .map((j) => (typeof j?.id === "string" ? { id: j.id } : typeof j?._id === "string" ? { id: j._id } : null))
    .filter(Boolean);
}

/**
 * Protibha chat – 2-stage AI assistant.
 *
 * Body: {
 *   messages:  [{ role, content }],
 *   jobDraft?: { ... },
 *   lastJobs?: [{ id }],         // session memory: last shown job IDs
 * }
 */
router.post("/ai/chat", requireUser, async (req, res) => {
  const userId = req.userId;
  const user = req.user;
  const messages = sanitizeChatMessages(req.body?.messages);
  const jobDraft = sanitizeJobDraft(req.body?.jobDraft);
  const lastJobs = sanitizeLastJobs(req.body?.lastJobs);

  try {
    const result = await handleProtibhaChat(userId, user.role, messages, jobDraft, {
      lastJobs,
    });
    res.json(result);
  } catch (e) {
    logger.error({ err: e }, "Protibha chat error");
    res.status(500).json({
      message: "Something went wrong. Please try again.",
      action: "error",
    });
  }
});

router.post("/ai/analyze-portfolio", requireSeeker, async (req, res) => {
  const seekerId = req.seekerId;
  const user = req.seeker;
  const rawText = String(req.body?.rawText || "").slice(0, MAX_PORTFOLIO_TEXT);
  const projects = Array.isArray(req.body?.projects)
    ? req.body.projects
      .slice(0, MAX_PROJECTS)
      .map((p) => String(p || "").slice(0, MAX_PROJECT_FIELD_CHARS))
      .filter(Boolean)
    : [];
  const links = Array.isArray(req.body?.links)
    ? req.body.links
      .slice(0, MAX_LINKS)
      .map((l) => String(l || "").slice(0, MAX_LINK_CHARS))
      .filter(Boolean)
    : [];

  const result = await analyzePortfolio(rawText, projects, links, { userId: seekerId });
  if (result.paymentRequired) {
    return res.status(402).json({
      message: "AI credits exhausted. Please purchase more to use this feature.",
      action: "payment_required",
      detail: "Payment required",
    });
  }
  const aiExtracted = {
    skills: result.skills,
    experience: result.experience,
    category: result.category,
    score: result.score,
  };

  await Portfolio.create({
    seeker: seekerId,
    rawText,
    projects,
    links,
  });

  const existingSkills = new Set(user.skills || []);
  for (const s of result.skills) {
    if (s && !existingSkills.has(s)) existingSkills.add(s);
  }
  await User.findByIdAndUpdate(seekerId, {
    $set: { aiExtracted, skills: [...existingSkills].slice(0, 30) },
  });
  invalidateUserCache(seekerId);

  res.json({
    skills: result.skills,
    experience: result.experience,
    category: result.category,
    score: result.score,
    feedback: result.feedback,
  });
});

/**
 * Get chat history from server-side session.
 * Supports pagination: ?limit=5&before=<index>
 *   - Returns the latest `limit` messages by default.
 *   - Pass `before` (0-based index from the end) to load older messages.
 *   e.g. first call: ?limit=5 → returns last 5 messages (indices totalCount-5..totalCount-1)
 *        scroll up: ?limit=5&before=5 → returns the 5 before those
 */
router.get("/ai/chat/history", requireUser, async (req, res) => {
  try {
    const session = await ChatSession.findOne({ user: req.userId, active: true })
      .sort({ updatedAt: -1 }).lean();
    if (!session || !session.messages?.length) {
      return res.json({ messages: [], memory: {}, totalCount: 0, hasMore: false });
    }

    const allMessages = session.messages;
    const totalCount = allMessages.length;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 50);
    const before = parseInt(req.query.before) || 0;

    // Messages are stored chronologically. We return slices from the end.
    // "before" means "skip this many from the end"
    const endIndex = totalCount - before;
    const startIndex = Math.max(0, endIndex - limit);

    if (endIndex <= 0) {
      return res.json({ messages: [], memory: session.memory || {}, totalCount, hasMore: false });
    }

    const slice = allMessages.slice(startIndex, endIndex).map(m => ({
      role: m.role,
      content: m.content,
      action: m.action || null,
      payload: m.payload || null,
    }));

    res.json({
      messages: slice,
      memory: session.memory || {},
      lastJobIds: (session.lastJobIds || []).map(id => id.toString()),
      totalCount,
      hasMore: startIndex > 0,
    });
  } catch (e) {
    logger.error({ err: e }, "Chat history error");
    res.json({ messages: [], memory: {}, totalCount: 0, hasMore: false });
  }
});

/**
 * Clear chat session (start fresh).
 */
router.post("/ai/chat/clear", requireUser, async (req, res) => {
  try {
    await ChatSession.updateMany(
      { user: req.userId, active: true },
      { $set: { active: false } }
    );
    res.json({ success: true, message: "Chat cleared" });
  } catch (e) {
    logger.error({ err: e }, "Chat clear error");
    res.status(500).json({ detail: "Failed to clear chat" });
  }
});

/** Match: seekerId → jobs for seeker; jobId → candidates for employer */
router.post("/ai/match", requireUser, asyncHandler(async (req, res) => {
  const { seekerId, jobId, limit = 5 } = req.body;
  if (seekerId && jobId) return res.status(400).json({ detail: "Provide seekerId or jobId, not both" });
  if (!seekerId && !jobId) return res.status(400).json({ detail: "Provide seekerId or jobId" });
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

  if (seekerId) {
    if (req.userRole !== "seeker" || req.userId !== seekerId) {
      return res.status(403).json({ detail: "You can only request matches for your own seeker profile" });
    }

    const seeker = await User.findById(seekerId).lean();
    if (!seeker || seeker.role !== "seeker") return res.json({ jobs: [] });
    const skills = seeker.skills || [];
    const aiSkills = seeker.aiExtracted?.skills || [];
    const allSkills = [...new Set([...skills, ...aiSkills])];
    const query = { status: "active" };
    if (allSkills.length) {
      const skillRegex = allSkills.slice(0, 8).filter(Boolean).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      if (skillRegex) {
        query.$or = [
          { skills: { $in: allSkills } },
          { category: new RegExp(skillRegex, "i") },
          { title: new RegExp(skillRegex, "i") },
        ];
      }
    }
    const jobsRaw = await Job.find(query).sort({ postedDate: -1 }).limit(30).lean();
    if (!jobsRaw.length) return res.json({ jobs: [] });
    for (const j of jobsRaw) j.id = j._id.toString();
    const rankedIds = await rankJobsForSeeker(seeker, jobsRaw, lim, { userId: req.userId });
    if (rankedIds && rankedIds.paymentRequired) {
      return res.status(402).json({
        message: "AI credits exhausted. Please purchase more to use AI matching.",
        action: "payment_required",
        detail: "Payment required",
      });
    }
    const idToJob = Object.fromEntries(jobsRaw.map(j => [j._id.toString(), j]));
    const jobsOrdered = rankedIds.map(id => idToJob[id]).filter(Boolean);
    return res.json({ jobs: jobsOrdered.map(sanitizeJob) });
  }

  const job = await Job.findById(jobId).lean();
  if (!job) return res.status(404).json({ detail: "Job not found" });
  if (req.userRole !== "employer" || job.employerId !== req.userId) {
    return res.status(403).json({ detail: "You can only request candidates for your own jobs" });
  }
  const jobSkills = job.skills || [];
  const query = { role: "seeker" };
  if (jobSkills.length) {
    query.$or = [
      { skills: { $in: jobSkills } },
      { "aiExtracted.skills": { $in: jobSkills } },
    ];
  }
  const seekersRaw = await User.find(query).limit(30).lean();
  if (!seekersRaw.length) return res.json({ candidates: [] });
  for (const s of seekersRaw) s.id = s._id.toString();
  const rankedIds = await rankCandidatesForJob(job, seekersRaw, lim, { userId: req.userId });
  if (rankedIds && rankedIds.paymentRequired) {
    return res.status(402).json({
      message: "AI credits exhausted. Please purchase more to use AI matching.",
      action: "payment_required",
      detail: "Payment required",
    });
  }
  const idToSeeker = Object.fromEntries(seekersRaw.map(s => [s._id.toString(), s]));
  const seekersOrdered = rankedIds.map(id => idToSeeker[id]).filter(Boolean);
  res.json({ candidates: seekersOrdered.map(serializeDoc) });
}));

export default router;
