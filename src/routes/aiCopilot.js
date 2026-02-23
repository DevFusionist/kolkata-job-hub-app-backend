import { Router } from "express";
import { User, Job, ImprovementLog } from "../models/index.js";
import { requireSeeker } from "../middleware/auth.js";
import { invalidateUserCache } from "../middleware/jwt.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  auditProfile,
  suggestSkillsWithImpact,
  rewriteExperience,
  predictSalaryImpact,
  getCareerPath,
  getDashboardNudges,
  checkSkillGap,
  computeScores,
} from "../services/aiCopilot.js";
const router = Router();

/**
 * POST /ai/copilot/audit — Full AI profile audit.
 */
router.post("/ai/copilot/audit", requireSeeker, asyncHandler(async (req, res) => {
  const user = req.seeker;
  const result = await auditProfile(user, { userId: req.seekerId });

  if (result.paymentRequired) {
    return res.status(402).json({
      message: "AI credits exhausted. Please purchase more.",
      action: "payment_required",
    });
  }

  await User.findByIdAndUpdate(req.seekerId, {
    $set: {
      hireScore: result.hireScore,
      trustScore: result.trustScore,
      profileScore: result.profileScore,
      "copilotAudit.strengths": result.strengths,
      "copilotAudit.weaknesses": result.weaknesses,
      "copilotAudit.hiringProbability": result.hiringProbability,
      "copilotAudit.salaryPotential": result.salaryPotential,
      "copilotAudit.lastAuditAt": new Date(),
    },
  });
  invalidateUserCache(req.seekerId);

  await ImprovementLog.create({
    user: req.seekerId,
    action: "Profile audit completed",
    category: "profile_audit",
    scoreBefore: user.hireScore || 0,
    scoreAfter: result.hireScore,
    scoreChange: result.hireScore - (user.hireScore || 0),
  });

  res.json(result);
}));

/**
 * POST /ai/copilot/career-intent — Save career goal & preferences.
 */
router.post("/ai/copilot/career-intent", requireSeeker, asyncHandler(async (req, res) => {
  const { careerGoal, workType, salaryExpectation, preferredLocation } = req.body;

  const update = {};
  if (careerGoal !== undefined) update.careerGoal = String(careerGoal).slice(0, 100).trim();
  if (workType !== undefined && ["office", "remote", "hybrid", "field", ""].includes(workType)) {
    update.workType = workType;
  }
  if (preferredLocation !== undefined) update.location = String(preferredLocation).slice(0, 100).trim();
  if (salaryExpectation !== undefined) {
    const sal = parseInt(salaryExpectation, 10);
    if (!isNaN(sal) && sal >= 0) {
      update["preferredSalary.min"] = sal;
    }
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ detail: "No valid fields to update" });
  }

  const scores = computeScores({ ...req.seeker, ...update });
  update.profileScore = scores.profileScore;
  update.hireScore = scores.hireScore;

  const updated = await User.findByIdAndUpdate(req.seekerId, { $set: update }, { new: true }).lean();
  invalidateUserCache(req.seekerId);

  await ImprovementLog.create({
    user: req.seekerId,
    action: `Career goal set: ${update.careerGoal || careerGoal || "updated"}`,
    category: "career_goal_set",
    scoreBefore: req.seeker.profileScore || 0,
    scoreAfter: scores.profileScore,
    scoreChange: scores.profileScore - (req.seeker.profileScore || 0),
  });

  res.json({ success: true, scores, careerGoal: updated.careerGoal, workType: updated.workType });
}));

/**
 * POST /ai/copilot/suggest-skills — Smart skill suggestions with salary impact.
 */
router.post("/ai/copilot/suggest-skills", requireSeeker, asyncHandler(async (req, res) => {
  const result = await suggestSkillsWithImpact(req.seeker, { userId: req.seekerId });

  if (result.paymentRequired) {
    return res.status(402).json({
      message: "AI credits exhausted.",
      action: "payment_required",
    });
  }

  console.log("result", result);

  res.json(result);
}));

/**
 * POST /ai/copilot/add-skill — Add a skill and log improvement.
 */
router.post("/ai/copilot/add-skill", requireSeeker, asyncHandler(async (req, res) => {
  const { skill } = req.body;
  if (!skill || typeof skill !== "string") {
    return res.status(400).json({ detail: "skill is required" });
  }

  const trimmed = skill.trim().slice(0, 50);
  const user = req.seeker;
  const currentSkills = user.skills || [];

  if (currentSkills.length >= 30) {
    return res.status(400).json({ detail: "Maximum 30 skills allowed" });
  }
  if (currentSkills.includes(trimmed)) {
    return res.status(400).json({ detail: "Skill already exists" });
  }

  const newSkills = [...currentSkills, trimmed];
  const scores = computeScores({ ...user, skills: newSkills });

  await User.findByIdAndUpdate(req.seekerId, {
    $set: { skills: newSkills, profileScore: scores.profileScore, hireScore: scores.hireScore },
  });
  invalidateUserCache(req.seekerId);

  const scoreBefore = user.hireScore || 0;
  await ImprovementLog.create({
    user: req.seekerId,
    action: `Added skill: ${trimmed}`,
    category: "skill_added",
    scoreBefore,
    scoreAfter: scores.hireScore,
    scoreChange: scores.hireScore - scoreBefore,
    metadata: { skill: trimmed },
  });

  const matchCount = await Job.countDocuments({
    status: "active",
    skills: { $in: newSkills },
  });

  res.json({
    success: true,
    skills: newSkills,
    scores,
    newJobsUnlocked: matchCount,
  });
}));

/**
 * POST /ai/copilot/rewrite-experience — Rewrite experience for a target role.
 */
router.post("/ai/copilot/rewrite-experience", requireSeeker, asyncHandler(async (req, res) => {
  const { targetRole } = req.body;
  if (!targetRole) {
    return res.status(400).json({ detail: "targetRole is required" });
  }

  const result = await rewriteExperience(req.seeker, String(targetRole).slice(0, 100), { userId: req.seekerId });

  if (result.paymentRequired) {
    return res.status(402).json({
      message: "AI credits exhausted.",
      action: "payment_required",
    });
  }

  res.json(result);
}));

/**
 * POST /ai/copilot/apply-experience-rewrite — Apply the rewritten experience to profile.
 */
router.post("/ai/copilot/apply-experience-rewrite", requireSeeker, asyncHandler(async (req, res) => {
  const { rewrittenExperience } = req.body;
  if (!rewrittenExperience) {
    return res.status(400).json({ detail: "rewrittenExperience is required" });
  }

  const user = req.seeker;
  const text = String(rewrittenExperience).slice(0, 500).trim();
  const scores = computeScores({ ...user, experience: text });

  await User.findByIdAndUpdate(req.seekerId, {
    $set: { experience: text, aiOptimized: true, profileScore: scores.profileScore, hireScore: scores.hireScore },
  });
  invalidateUserCache(req.seekerId);

  await ImprovementLog.create({
    user: req.seekerId,
    action: "Experience rewritten with AI",
    category: "experience_rewrite",
    scoreBefore: user.hireScore || 0,
    scoreAfter: scores.hireScore,
    scoreChange: scores.hireScore - (user.hireScore || 0),
  });

  res.json({ success: true, scores });
}));

/**
 * POST /ai/copilot/salary-prediction — Predict salary impact of adding a skill.
 */
router.post("/ai/copilot/salary-prediction", requireSeeker, asyncHandler(async (req, res) => {
  const { skill } = req.body;
  if (!skill) {
    return res.status(400).json({ detail: "skill is required" });
  }

  const result = await predictSalaryImpact(req.seeker, String(skill).slice(0, 50), { userId: req.seekerId });

  if (result.paymentRequired) {
    return res.status(402).json({
      message: "AI credits exhausted.",
      action: "payment_required",
    });
  }

  res.json(result);
}));

/**
 * POST /ai/copilot/career-path — Generate career progression path.
 */
router.post("/ai/copilot/career-path", requireSeeker, asyncHandler(async (req, res) => {
  const result = await getCareerPath(req.seeker, { userId: req.seekerId });

  if (result.paymentRequired) {
    return res.status(402).json({
      message: "AI credits exhausted.",
      action: "payment_required",
    });
  }

  res.json(result);
}));

/**
 * GET /ai/copilot/dashboard — Dashboard nudges + scores.
 */
router.get("/ai/copilot/dashboard", requireSeeker, asyncHandler(async (req, res) => {
  const result = await getDashboardNudges(req.seeker);
  res.json(result);
}));

/**
 * POST /ai/copilot/skill-gap — Check skill gap for a job before applying.
 */
router.post("/ai/copilot/skill-gap", requireSeeker, asyncHandler(async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) {
    return res.status(400).json({ detail: "jobId is required" });
  }

  const job = await Job.findById(jobId).lean();
  if (!job) {
    return res.status(404).json({ detail: "Job not found" });
  }

  const result = checkSkillGap(req.seeker, job);
  res.json(result);
}));

/**
 * GET /ai/copilot/improvement-log — Get improvement history.
 */
router.get("/ai/copilot/improvement-log", requireSeeker, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
  const logs = await ImprovementLog.find({ user: req.seekerId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json({
    logs: logs.map(l => ({
      id: l._id.toString(),
      action: l.action,
      category: l.category,
      scoreChange: l.scoreChange,
      scoreBefore: l.scoreBefore,
      scoreAfter: l.scoreAfter,
      date: l.createdAt,
    })),
  });
}));

export default router;
