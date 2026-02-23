import OpenAI from "openai";
import logger from "../lib/logger.js";
import { clampAiOutputTokens, enforceAiBudget, truncateAiInput } from "../lib/aiBudget.js";
import { reserveAiCredits, rollbackAiCredits } from "../lib/aiCredits.js";
import { Job } from "../models/index.js";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_AVAILABLE = !!process.env.OPENAI_API_KEY;
let client = null;

function getClient() {
  if (!OPENAI_AVAILABLE) return null;
  if (client) return client;
  try {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return client;
  } catch (e) {
    logger.warn({ err: e.message }, "OpenAI init failed");
    return null;
  }
}

function parseJsonFromResponse(raw) {
  if (!raw?.trim()) return null;
  raw = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(raw);
  } catch {
    return repairTruncatedJson(raw);
  }
}

/**
 * Attempt to repair JSON that was truncated mid-stream (e.g. max_tokens hit).
 * Strategy: close any open arrays/objects from the end.
 */
function repairTruncatedJson(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // Strip trailing comma
  s = s.replace(/,\s*$/, "");
  // Count open/close braces and brackets
  let braces = 0, brackets = 0;
  let inString = false, escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }
  if (inString) s += '"';
  while (brackets > 0) { s += "]"; brackets--; }
  while (braces > 0) { s += "}"; braces--; }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function estimateTokensForCall(promptText, maxOutputTokens) {
  return Math.ceil(String(promptText || "").length / 4) + Math.max(1, parseInt(maxOutputTokens, 10) || 200);
}

async function chatJson(system, userContent, opts = {}) {
  const c = getClient();
  if (!c) {
    logger.warn("chatJson: OpenAI client unavailable (no API key?)");
    return { result: null, paymentRequired: false };
  }
  const maxTokens = clampAiOutputTokens(opts.maxTokens, 350);
  const prompt = truncateAiInput(`${system}\n\n${userContent}`);
  const estimated = estimateTokensForCall(prompt, maxTokens);
  const reservation = await reserveAiCredits(opts.userId, estimated);
  if (!reservation.ok) {
    return { result: null, paymentRequired: true };
  }
  try {
    const budget = enforceAiBudget({ userId: opts.userId, promptText: prompt, maxOutputTokens: maxTokens });
    if (!budget.ok) {
      logger.warn({ userId: opts.userId, reason: budget.reason }, "chatJson: budget rejected");
      await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
      return { result: null, paymentRequired: false };
    }
    const r = await c.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: truncateAiInput(userContent) },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
    });
    const choice = r.choices[0];
    const raw = (choice?.message?.content || "").trim();

    if (choice?.finish_reason === "length" && raw) {
      logger.warn({ maxTokens, rawLen: raw.length }, "chatJson: response truncated (finish_reason=length), attempting repair");
      const repaired = repairTruncatedJson(raw);
      if (repaired) return { result: repaired, paymentRequired: false };
    }

    const result = raw ? parseJsonFromResponse(raw) : null;
    if (!result && raw) {
      logger.warn({ rawLen: raw.length, rawSnippet: raw.slice(0, 200) }, "chatJson: JSON parse failed");
    }
    return { result, paymentRequired: false };
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack?.split("\n").slice(0, 3).join(" | ") }, "chatJson: OpenAI call failed");
    await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
    return { result: null, paymentRequired: false };
  }
}

/**
 * Compute profile, hire, and trust scores from user data (no AI call).
 */
export function computeScores(user) {
  let profileScore = 0;
  if (user.name?.trim()) profileScore += 10;
  if (user.phone) profileScore += 5;
  if (user.location?.trim()) profileScore += 10;
  if (user.languages?.length) profileScore += 10;
  if (user.skills?.length >= 3) profileScore += 15;
  else if (user.skills?.length >= 1) profileScore += 8;
  if (user.experience && user.experience !== "Fresher") profileScore += 10;
  if (user.education?.trim()) profileScore += 5;
  if (user.careerGoal?.trim()) profileScore += 10;
  if (user.workType) profileScore += 5;
  if (user.preferredSalary?.min > 0) profileScore += 5;
  const hasResume = !!user.resumeUrl || !!user.generatedResumeUrl;
  if (hasResume) profileScore += 15;

  let trustScore = 20;
  if (user.phoneVerified) trustScore += 20;
  if (user.photoVerified) trustScore += 20;
  if (user.idVerified) trustScore += 20;
  if (user.aiOptimized) trustScore += 10;
  if (user.skills?.length >= 3) trustScore += 10;

  let hireScore = Math.round(profileScore * 0.5 + trustScore * 0.3);
  if (user.skills?.length >= 5) hireScore += 5;
  if (user.languages?.length >= 2) hireScore += 5;
  if (user.careerGoal?.trim()) hireScore += 5;

  return {
    profileScore: Math.min(100, Math.max(0, profileScore)),
    hireScore: Math.min(100, Math.max(0, hireScore)),
    trustScore: Math.min(100, Math.max(0, trustScore)),
  };
}

/**
 * Full AI profile audit: analyzes strengths, weaknesses, hiring probability, salary potential.
 */
export async function auditProfile(user, opts = {}) {
  const scores = computeScores(user);
  const fallback = {
    ...scores,
    strengths: [],
    weaknesses: [],
    hiringProbability: scores.hireScore,
    salaryPotential: "",
    missingSkills: [],
    recommendations: [],
  };

  if (!OPENAI_AVAILABLE) return fallback;

  const userSummary = buildUserSummary(user);
  const jobStats = await getMarketSnapshot(user);

  const system = `You are HireBoost AI, a career optimization engine for Kolkata's local job market.
Analyze this job seeker's profile and provide a comprehensive audit.
Context: This platform serves blue-collar and entry-level workers in Kolkata.

Output ONLY valid JSON with keys:
- strengths: string[] (3-5 positive profile aspects, short phrases)
- weaknesses: string[] (3-5 areas to improve, short phrases)
- missingSkills: string[] (top 5 skills they should add based on Kolkata market demand)
- hiringProbability: number (0-100, estimated chance of getting hired in 30 days)
- salaryPotential: string (estimated salary range like "₹12,000 - ₹18,000/month")
- recommendations: string[] (3-5 actionable next steps, short phrases)`;

  const userContent = `SEEKER PROFILE:
${userSummary}

KOLKATA MARKET SNAPSHOT:
${jobStats}

Audit this profile and return JSON:`;

  const { result, paymentRequired } = await chatJson(system, userContent, { userId: opts.userId, maxTokens: 350 });
  if (paymentRequired) return { ...fallback, paymentRequired: true };
  if (!result) return fallback;

  return {
    ...scores,
    strengths: asStringArray(result.strengths, 5),
    weaknesses: asStringArray(result.weaknesses, 5),
    missingSkills: asStringArray(result.missingSkills, 5),
    hiringProbability: clampNum(result.hiringProbability, 0, 100, scores.hireScore),
    salaryPotential: String(result.salaryPotential || "").trim(),
    recommendations: asStringArray(result.recommendations, 5),
  };
}

/**
 * Suggest skills with salary impact and hiring demand data.
 */
export async function suggestSkillsWithImpact(user, opts = {}) {
  const fallback = { skills: [] };
  if (!OPENAI_AVAILABLE) return fallback;

  const careerGoal = user.careerGoal || user.aiExtracted?.category || "General";
  const currentSkills = [...new Set([...(user.skills || []), ...(user.aiExtracted?.skills || [])])];
  const jobStats = await getMarketSnapshot(user);

  const system = `You are HireBoost AI for Kolkata's local job market.
Suggest skills this candidate should add to improve their hiring chances.
For each skill, provide salary impact and hiring demand.

Output ONLY valid JSON:
{
  "skills": [
    {
      "skill": "Excel",
      "salaryImpact": "+₹2,000/month",
      "demandLevel": "high",
      "reason": "Required by 65% of office jobs in Kolkata"
    }
  ]
}
Max 5 skills. Only suggest skills they DON'T already have. Keep reasons under 15 words.`;

  const userContent = `CAREER GOAL: ${careerGoal}
CURRENT SKILLS: ${currentSkills.join(", ") || "None"}
LOCATION: ${user.location || "Kolkata"}
EXPERIENCE: ${user.experience || "Fresher"}

MARKET DATA:
${jobStats}

Suggest skills with impact:`;

  const { result, paymentRequired } = await chatJson(system, userContent, { userId: opts.userId, maxTokens: 350 });
  if (paymentRequired) return { ...fallback, paymentRequired: true };
  if (!result?.skills) return fallback;

  const skills = (Array.isArray(result.skills) ? result.skills : [])
    .filter(s => s?.skill)
    .slice(0, 5)
    .map(s => ({
      skill: String(s.skill).trim(),
      salaryImpact: String(s.salaryImpact || "").trim(),
      demandLevel: ["high", "medium", "low"].includes(s.demandLevel) ? s.demandLevel : "medium",
      reason: String(s.reason || "").trim(),
    }));

  return { skills };
}

/**
 * Rewrite experience text for a target role.
 */
export async function rewriteExperience(user, targetRole, opts = {}) {
  const fallback = { original: user.experience || "", rewritten: "", targetRole };
  if (!OPENAI_AVAILABLE) return fallback;

  const system = `You are HireBoost AI. Rewrite this candidate's work experience to better match the target job role.
Make it professional but authentic—don't fabricate. Optimize wording for local Kolkata employers.

Output ONLY valid JSON:
{
  "rewritten": "The rewritten experience text (2-3 sentences max)",
  "improvements": ["list of what was improved"]
}`;

  const userContent = `CURRENT EXPERIENCE: ${user.experience || "Fresher"}
CURRENT SKILLS: ${(user.skills || []).join(", ")}
TARGET ROLE: ${targetRole}
LOCATION: ${user.location || "Kolkata"}

Rewrite experience for this target role:`;

  const { result, paymentRequired } = await chatJson(system, userContent, { userId: opts.userId, maxTokens: 250 });
  if (paymentRequired) return { ...fallback, paymentRequired: true };
  if (!result) return fallback;

  return {
    original: user.experience || "",
    rewritten: String(result.rewritten || "").trim(),
    improvements: asStringArray(result.improvements, 5),
    targetRole,
  };
}

/**
 * Predict salary impact of adding a specific skill.
 */
export async function predictSalaryImpact(user, skill, opts = {}) {
  const fallback = { skill, currentRange: "", projectedRange: "", increase: "", percentIncrease: 0 };
  if (!OPENAI_AVAILABLE) return fallback;

  const system = `You are HireBoost AI salary analyst for Kolkata's job market.
Estimate the salary impact of adding a specific skill for this candidate.
Base your estimate on local Kolkata hiring trends for entry-level and blue-collar workers.

Output ONLY valid JSON:
{
  "currentRange": "₹10,000 - ₹14,000/month",
  "projectedRange": "₹12,000 - ₹17,000/month",
  "increase": "+₹2,000 - ₹3,000/month",
  "percentIncrease": 18
}`;

  const userContent = `CANDIDATE: skills=${(user.skills || []).join(", ")}, experience=${user.experience || "Fresher"}, location=${user.location || "Kolkata"}
SKILL TO ADD: ${skill}

Predict salary impact:`;

  const { result, paymentRequired } = await chatJson(system, userContent, { userId: opts.userId, maxTokens: 200 });
  if (paymentRequired) return { ...fallback, paymentRequired: true };
  if (!result) return fallback;

  return {
    skill,
    currentRange: String(result.currentRange || "").trim(),
    projectedRange: String(result.projectedRange || "").trim(),
    increase: String(result.increase || "").trim(),
    percentIncrease: clampNum(result.percentIncrease, 0, 100, 0),
  };
}

/**
 * Generate career path from current role.
 */
export async function getCareerPath(user, opts = {}) {
  const fallback = { path: [], timeframe: "" };
  if (!OPENAI_AVAILABLE) return fallback;

  const currentRole = user.careerGoal || user.aiExtracted?.category || user.experience || "Entry level";

  const system = `You are HireBoost AI career advisor for Kolkata's local job market.
Generate a realistic career progression path for this candidate.
Focus on roles available in Kolkata for blue-collar and entry-level workers.

Output ONLY valid JSON:
{
  "path": [
    { "role": "Telecaller", "salary": "₹10,000/month", "timeframe": "Now" },
    { "role": "Team Lead", "salary": "₹18,000/month", "timeframe": "1-2 years" },
    { "role": "Manager", "salary": "₹30,000/month", "timeframe": "3-5 years" }
  ],
  "skillsNeeded": ["Leadership", "Excel", "English"],
  "advice": "One sentence of career advice"
}`;

  const userContent = `CANDIDATE: role=${currentRole}, skills=${(user.skills || []).join(", ")}, experience=${user.experience || "Fresher"}, location=${user.location || "Kolkata"}

Generate career path:`;

  const { result, paymentRequired } = await chatJson(system, userContent, { userId: opts.userId, maxTokens: 300 });
  if (paymentRequired) return { ...fallback, paymentRequired: true };
  if (!result) return fallback;

  const path = (Array.isArray(result.path) ? result.path : []).slice(0, 5).map(p => ({
    role: String(p.role || "").trim(),
    salary: String(p.salary || "").trim(),
    timeframe: String(p.timeframe || "").trim(),
  }));

  return {
    path,
    skillsNeeded: asStringArray(result.skillsNeeded, 8),
    advice: String(result.advice || "").trim(),
  };
}

/**
 * Get dashboard nudges for the home screen.
 */
export async function getDashboardNudges(user) {
  const nudges = [];
  const scores = computeScores(user);

  if (scores.profileScore < 60) {
    nudges.push({
      type: "profile_incomplete",
      title: `Your profile is ${scores.profileScore}% complete`,
      subtitle: "Improve to get 3X more job matches.",
      cta: "Improve now",
      priority: 1,
    });
  }

  if (!user.careerGoal?.trim()) {
    nudges.push({
      type: "no_career_goal",
      title: "Set your career goal",
      subtitle: "Tell us what job you want to unlock personalized matches.",
      cta: "Set goal",
      priority: 2,
    });
  }

  if ((user.skills?.length || 0) < 3) {
    nudges.push({
      type: "few_skills",
      title: "Add more skills",
      subtitle: "Candidates with 5+ skills get 40% more interviews.",
      cta: "Add skills",
      priority: 3,
    });
  }

  if (scores.trustScore < 50) {
    nudges.push({
      type: "low_trust",
      title: "Recruiters are skipping your profile",
      subtitle: "Add trust signals to stand out.",
      cta: "Boost trust",
      priority: 4,
    });
  }

  if (user.aiOptimized) {
    const matchCount = await Job.countDocuments({
      status: "active",
      skills: { $in: user.skills || [] },
    });
    if (matchCount > 0) {
      nudges.push({
        type: "jobs_unlocked",
        title: `You match ${matchCount} active jobs`,
        subtitle: "Your optimized profile is working.",
        cta: "View jobs",
        priority: 5,
      });
    }
  }

  return { nudges: nudges.sort((a, b) => a.priority - b.priority), scores };
}

/**
 * Check skill gaps before applying to a job.
 */
export function checkSkillGap(user, job) {
  const userSkills = new Set([...(user.skills || []), ...(user.aiExtracted?.skills || [])].map(s => s.toLowerCase().trim()));
  const jobSkills = (job.skills || []).map(s => s.trim());
  const missing = jobSkills.filter(s => !userSkills.has(s.toLowerCase()));
  const matched = jobSkills.filter(s => userSkills.has(s.toLowerCase()));
  const matchPercent = jobSkills.length > 0 ? Math.round((matched.length / jobSkills.length) * 100) : 100;

  return {
    missing,
    matched,
    matchPercent,
    hasGap: missing.length > 0,
    message: missing.length > 0
      ? `This job requires skills you haven't highlighted: ${missing.join(", ")}. Improve your profile to increase chances.`
      : "Your skills match this job well!",
  };
}


// --- Helpers ---

function buildUserSummary(user) {
  const lines = [];
  lines.push(`Name: ${user.name || "N/A"}`);
  lines.push(`Location: ${user.location || "N/A"}`);
  lines.push(`Experience: ${user.experience || "Fresher"}`);
  lines.push(`Skills: ${(user.skills || []).join(", ") || "None"}`);
  lines.push(`Languages: ${(user.languages || []).join(", ") || "None"}`);
  lines.push(`Education: ${user.education || "N/A"}`);
  lines.push(`Career goal: ${user.careerGoal || "Not set"}`);
  lines.push(`Work type: ${user.workType || "Not set"}`);
  lines.push(`Phone verified: ${user.phoneVerified ? "Yes" : "No"}`);
  lines.push(`Photo verified: ${user.photoVerified ? "Yes" : "No"}`);
  lines.push(`ID verified: ${user.idVerified ? "Yes" : "No"}`);
  return lines.join("\n");
}

async function getMarketSnapshot(user) {
  try {
    const location = user.location || "Kolkata";
    const category = user.careerGoal || user.aiExtracted?.category || "";
    const query = { status: "active" };
    if (category) query.category = category;

    const jobs = await Job.find(query).sort({ postedDate: -1 }).limit(50).lean();
    if (!jobs.length) return "No active jobs found in this category.";

    const skillCounts = {};
    let salaryTotal = 0;
    let salaryCount = 0;
    for (const j of jobs) {
      for (const s of (j.skills || [])) {
        skillCounts[s] = (skillCounts[s] || 0) + 1;
      }
      if (j.salaryMin > 0) {
        salaryTotal += j.salaryMin;
        salaryCount++;
      }
    }

    const topSkills = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const avgSalary = salaryCount > 0 ? Math.round(salaryTotal / salaryCount) : 0;

    const lines = [];
    lines.push(`Active jobs in ${category || "all categories"}: ${jobs.length}`);
    lines.push(`Top demanded skills: ${topSkills.map(([s, c]) => `${s}(${c})`).join(", ")}`);
    if (avgSalary > 0) lines.push(`Average starting salary: ₹${avgSalary.toLocaleString("en-IN")}/month`);
    lines.push(`Location focus: ${location}`);
    return lines.join("\n");
  } catch (e) {
    logger.warn({ err: e.message }, "Market snapshot failed");
    return "Market data unavailable.";
  }
}

function asStringArray(val, max = 5) {
  if (!Array.isArray(val)) return [];
  return val.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()).slice(0, max);
}

function clampNum(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
