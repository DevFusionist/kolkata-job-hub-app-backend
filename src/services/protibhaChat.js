/**
 * Protibha – 2-stage AI chat assistant for Kolkata Job Hub.
 *
 * Architecture:
 *   User → Intent Layer → AI Call 1 (understand + filters) → DB query → AI Call 2 (format response)
 *
 * Capabilities:
 *   1. Quick Actions  – slash commands, bypass intent detection entirely
 *   2. Natural Search  – AI extracts filters from free text, DB executes, AI formats
 *   3. Apply via Chat – uses session memory (lastJobs) to target specific jobs
 *   4. Server-side ChatSession – persistent conversation memory
 *   5. Smart context: salary preference, language, portfolio, previous applications
 *
 * Employer flow: step-by-step job creation wizard + /findCandidates.
 *
 * ALL DB access goes through Mongoose models.
 */

import OpenAI from "openai";
import {
  User, Job, Application, Portfolio, ChatSession,
  CATEGORIES, JOB_TYPES, EXPERIENCE_LEVELS,
} from "../models/index.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { invalidateUserCache } from "../middleware/jwt.js";
import { rankJobsForSeeker, rankCandidatesForJob } from "./ai.js";
import { clampAiOutputTokens, enforceAiBudget, truncateAiInput } from "../lib/aiBudget.js";
import { reserveJobPostingQuota, rollbackJobPostingQuota } from "../lib/employerEntitlements.js";
import { reserveAiCredits, rollbackAiCredits, deductAiCredits } from "../lib/aiCredits.js";
import logger from "../lib/logger.js";

/* ──────────────────── Constants ──────────────────── */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_AVAILABLE = !!process.env.OPENAI_API_KEY;

const JOB_CATEGORIES = CATEGORIES;
const MAX_DESCRIPTION_LEN = 2000;
const MIN_DESCRIPTION_LEN = 8;
const DB_LIMIT = 30;
const RANK_LIMIT = 10;
const MAX_SESSION_MESSAGES = 200;

// User-facing messages: all in English for consistency (no mixed Hindi/Bengali).
const MSG_AI_CREDITS_EXHAUSTED = "Your AI credits are used up. Please buy more to continue using AI.";
const MSG_AI_CREDITS_TRY_AGAIN = "Your AI credits are used up. Please buy more to try again.";
const MSG_JOB_POST_PAYMENT_REQUIRED = "Your free job posts are used up. Payment required.";

/* ──────────────────── OpenAI helpers ──────────────────── */

function getClient() {
  if (!OPENAI_AVAILABLE) return null;
  try {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch {
    return null;
  }
}

function parseJson(raw) {
  if (!raw?.trim()) return null;
  raw = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(raw); } catch { return null; }
}

function estimateTokensForCall(promptText, maxOutputTokens) {
  return Math.ceil(String(promptText || "").length / 4) + Math.max(1, parseInt(maxOutputTokens, 10) || 200);
}

async function aiJson(systemPrompt, userPrompt, opts = {}) {
  const client = getClient();
  if (!client) return { result: null, paymentRequired: false };
  const maxTokens = clampAiOutputTokens(opts.maxTokens, 220);
  const prompt = truncateAiInput(`${systemPrompt}\n\n${userPrompt}`);
  const estimated = estimateTokensForCall(prompt, maxTokens);
  const reservation = await reserveAiCredits(opts.userId, estimated);
  if (!reservation.ok) {
    return { result: null, paymentRequired: true };
  }
  try {
    const budget = enforceAiBudget({ userId: opts.userId, promptText: prompt, maxOutputTokens: maxTokens });
    if (!budget.ok) {
      await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
      return { result: null, paymentRequired: false };
    }
    const r = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: truncateAiInput(systemPrompt) },
        { role: "user", content: truncateAiInput(userPrompt) },
      ],
      temperature: opts.temperature ?? 0.2,
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
    });
    const actualTokens = (r.usage?.total_tokens ?? ((r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0))) || estimated;
    await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
    await deductAiCredits(opts.userId, actualTokens);
    const parsed = parseJson(r.choices[0]?.message?.content || "");
    return { result: parsed, paymentRequired: false };
  } catch (e) {
    logger.error({ err: e.message }, "AI JSON call failed");
    await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
    return { result: null, paymentRequired: false };
  }
}

async function aiText(systemPrompt, userPrompt, opts = {}) {
  const client = getClient();
  if (!client) return { result: null, paymentRequired: false };
  const maxTokens = clampAiOutputTokens(opts.maxTokens, 220);
  const prompt = truncateAiInput(`${systemPrompt}\n\n${userPrompt}`);
  const estimated = estimateTokensForCall(prompt, maxTokens);
  const reservation = await reserveAiCredits(opts.userId, estimated);
  if (!reservation.ok) {
    return { result: null, paymentRequired: true };
  }
  try {
    const budget = enforceAiBudget({ userId: opts.userId, promptText: prompt, maxOutputTokens: maxTokens });
    if (!budget.ok) {
      await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
      return { result: null, paymentRequired: false };
    }
    const r = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: truncateAiInput(systemPrompt) },
        { role: "user", content: truncateAiInput(userPrompt) },
      ],
      temperature: opts.temperature ?? 0.5,
      max_tokens: maxTokens,
    });
    const actualTokens = (r.usage?.total_tokens ?? ((r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0))) || estimated;
    await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
    await deductAiCredits(opts.userId, actualTokens);
    const text = (r.choices[0]?.message?.content || "").trim();
    return { result: text, paymentRequired: false };
  } catch (e) {
    logger.error({ err: e.message }, "AI text call failed");
    await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
    return { result: null, paymentRequired: false };
  }
}

/* ──────────────────── Utility helpers ──────────────────── */

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(text) {
  return String(text || "").toLowerCase()
    .replace(/\biin\b/g, " in ")
    .replace(/\bslat\s+lake\b/g, "salt lake")
    .replace(/\bsaltlake\b/g, "salt lake")
    .replace(/\bdelivary\b/g, "delivery")
    .replace(/\bdeliver\b/g, "delivery")
    .replace(/\s+/g, " ").trim();
}

function toAsciiDigits(text) {
  // Supports Bengali (০-৯) and Devanagari (०-९) numerals.
  const map = {
    "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9",
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
  };
  return String(text || "").replace(/[০-৯०-९]/g, (ch) => map[ch] || ch);
}

/* ──────────────────── ChatSession persistence ──────────────────── */

async function getOrCreateSession(userId) {
  let session = await ChatSession.findOne({ user: userId, active: true })
    .sort({ updatedAt: -1 });
  if (!session) {
    session = await ChatSession.create({ user: userId, messages: [], active: true });
  }
  return session;
}

async function appendSessionMessage(session, role, content, action = null, payload = null) {
  session.messages.push({ role, content, action, payload });
  if (session.messages.length > MAX_SESSION_MESSAGES) {
    session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
  }
  session.markModified("messages");
  await session.save();
}

async function updateSessionMemory(session, updates) {
  if (updates.lastJobIds) session.lastJobIds = updates.lastJobIds;
  if (updates.jobDraft !== undefined) {
    session.jobDraft = updates.jobDraft;
    session.markModified("jobDraft");
  }
  if ("jobPostingFlow" in updates) {
    session.memory = session.memory || {};
    session.memory.jobPostingFlow = updates.jobPostingFlow;
  }
  if (updates.preferredLocation) session.memory.preferredLocation = updates.preferredLocation;
  if (updates.preferredCategory) session.memory.preferredCategory = updates.preferredCategory;
  if (updates.lastSearchFilters) session.memory.lastSearchFilters = updates.lastSearchFilters;
  session.markModified("memory");
  await session.save();
}

/* ──────────────────── User profile helpers (enhanced) ──────────────────── */

async function buildUserProfile(user) {
  const skills = [...new Set([...(user.skills || []), ...(user.aiExtracted?.skills || [])])];
  const experience = user.aiExtracted?.experience || user.experience || "Fresher";
  const location = user.location || "";
  const name = user.name || "";
  const preferredSalary = user.preferredSalary || { min: 0, max: 0 };
  const preferredLanguage = user.preferredLanguage || "en";

  // Fetch portfolio skills (long-term memory)
  let portfolioSkills = [];
  try {
    const portfolio = await Portfolio.findOne({ seeker: user._id })
      .sort({ createdAt: -1 }).lean();
    if (portfolio?.rawText) {
      portfolioSkills = portfolio.rawText.split(/[,\n;]+/)
        .map(s => s.trim()).filter(s => s.length > 1 && s.length < 50).slice(0, 10);
    }
  } catch { /* ignore */ }

  // Fetch previous applications (long-term memory)
  let previousApps = [];
  try {
    previousApps = await Application.find({ seeker: user._id })
      .sort({ appliedDate: -1 })
      .limit(20)
      .populate("job", "title category location salary")
      .lean();
  } catch { /* ignore */ }

  const appliedJobIds = new Set(previousApps.map(a => a.job?._id?.toString()).filter(Boolean));
  const appliedCategories = [...new Set(previousApps.map(a => a.job?.category).filter(Boolean))];
  const appliedLocations = [...new Set(previousApps.map(a => a.job?.location).filter(Boolean))];

  return {
    skills,
    experience,
    location,
    name,
    preferredSalary,
    preferredLanguage,
    portfolioSkills,
    appliedJobIds,
    appliedCategories,
    appliedLocations,
    previousAppsCount: previousApps.length,
  };
}

/* ──────────────────── STAGE 1: Intent + Filter extraction (AI Call 1) ──────────────────── */

const INTENT_SYSTEM = `You are an intent classifier and search filter extractor for Kolkata Job Hub chat.

User is a JOB SEEKER. Classify the message into exactly ONE intent:
- "search" – find/browse/see jobs
- "apply"  – apply to a job (from previously shown list or by description)
- "similar" – find jobs similar to what they applied for or were shown
- "general" – greeting, question, or anything else

For "search", extract structured filters from the user's text:
- role: job title/role mentioned (e.g. "Delivery Boy", "Medical Representative", "Beautician")
- location: area/city mentioned (e.g. "Salt Lake", "Garia", "Dum Dum")
- job_type: "Full-time" or "Part-time" if mentioned
- salary_min: minimum salary number if mentioned
- experience: experience level if mentioned
- language: language requirement if mentioned
- shift: "day" or "night" if mentioned

For "apply", extract:
- apply_target: "first", "second", "third", "all", or a specific job title/description

Return ONLY valid JSON:
{
  "intent": "search|apply|similar|general",
  "filters": { "role": null, "location": null, "job_type": null, "salary_min": null, "experience": null, "language": null, "shift": null },
  "apply_target": null,
  "raw_search": "<cleaned search terms>"
}

Do NOT generate any user-facing text. Only structured JSON.`;

async function stage1_classifyIntent(userId, userMessage, userProfile, conversationHistory) {
  const profileCtx = `User profile: skills=${JSON.stringify(userProfile.skills)}, experience=${userProfile.experience}, location=${userProfile.location}, salary_pref=${JSON.stringify(userProfile.preferredSalary)}`;
  const historyCtx = conversationHistory.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");

  const userPrompt = `${profileCtx}

Recent conversation:
${historyCtx}

Current message: "${userMessage}"

Return JSON:`;

  const { result, paymentRequired } = await aiJson(INTENT_SYSTEM, userPrompt, { userId, maxTokens: 180 });
  if (paymentRequired) return { intentResult: null, paymentRequired: true };
  return { intentResult: result || { intent: "general", filters: {}, apply_target: null, raw_search: userMessage }, paymentRequired: false };
}

/* ──────────────────── Quick Action routing (no AI needed) ──────────────────── */

function isSlashCommand(msg) {
  return typeof msg === "string" && msg.startsWith("/");
}

function routeSlashCommand(command, user, profile) {
  switch (command) {
    case "/findNearByJobs":
      return {
        intent: "search",
        filters: { location: profile.location || "Kolkata" },
        searchType: "nearby",
      };
    case "/skillsMatchingJobs":
      return {
        intent: "search",
        filters: { skills: profile.skills },
        searchType: "skills_match",
      };
    case "/highestPayingJobs":
      return {
        intent: "search",
        filters: {},
        searchType: "highest_paying",
      };
    case "/buildResume":
      return { intent: "build_resume" };
    case "/postJob":
      return { intent: "employer_post" };
    case "/findCandidates":
      return { intent: "employer_find_candidates" };
    case "/tips":
      return { intent: "employer_tips" };
    default:
      return { intent: "general" };
  }
}

/* ──────────────────── DB Query execution (Mongoose) ──────────────────── */

async function executeJobSearch(user, filters, searchType, userProfile, { dbLimit = DB_LIMIT, rankLimit = RANK_LIMIT } = {}) {
  const query = { status: "active" };
  const sort = { postedDate: -1 };

  // Exclude already-applied jobs for seekers
  if (userProfile?.appliedJobIds?.size) {
    const excludeIds = [...userProfile.appliedJobIds].map(id => {
      try { return toObjectId(id); } catch { return null; }
    }).filter(Boolean);
    if (excludeIds.length) {
      query._id = { $nin: excludeIds };
    }
  }

  // Apply salary preference filter when available
  if (userProfile?.preferredSalary?.min > 0) {
    query.salaryMax = { $gte: userProfile.preferredSalary.min };
  }

  // Highest paying: sort by salaryMin descending
  if (searchType === "highest_paying") {
    const jobsRaw = await Job.find(query)
      .sort({ salaryMin: -1, postedDate: -1 })
      .limit(dbLimit)
      .lean();
    for (const j of jobsRaw) j.id = j._id.toString();
    const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit, { userId: user?._id?.toString?.() || user?.id });
    if (rankedIds && rankedIds.paymentRequired) return { jobs: [], paymentRequired: true };
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
    return { jobs: rankedIds.map((id) => idToJob[id]).filter(Boolean), paymentRequired: false };
  }

  // Skills match: match user skills + portfolio skills
  if (searchType === "skills_match") {
    const allSkills = [...new Set([
      ...(userProfile?.skills || []),
      ...(userProfile?.portfolioSkills || []),
    ])];
    if (allSkills.length) {
      const skillRegex = allSkills.slice(0, 12).map(escapeRegex).join("|");
      if (skillRegex) {
        query.$or = [
          { skills: { $in: allSkills } },
          { category: new RegExp(skillRegex, "i") },
          { title: new RegExp(skillRegex, "i") },
          { description: new RegExp(skillRegex, "i") },
        ];
      }
    }
    const jobsRaw = await Job.find(query).sort(sort).limit(dbLimit).lean();
    for (const j of jobsRaw) j.id = j._id.toString();
    const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit, { userId: user?._id?.toString?.() || user?.id });
    if (rankedIds && rankedIds.paymentRequired) return { jobs: [], paymentRequired: true };
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
    return { jobs: rankedIds.map((id) => idToJob[id]).filter(Boolean), paymentRequired: false };
  }

  // Similar jobs (based on last applied/shown categories and locations)
  if (searchType === "similar") {
    const orConditions = [];
    if (userProfile?.appliedCategories?.length) {
      orConditions.push({ category: { $in: userProfile.appliedCategories } });
    }
    if (userProfile?.appliedLocations?.length) {
      const locRegex = userProfile.appliedLocations.slice(0, 5).map(escapeRegex).join("|");
      if (locRegex) orConditions.push({ location: new RegExp(locRegex, "i") });
    }
    if (userProfile?.skills?.length) {
      orConditions.push({ skills: { $in: userProfile.skills } });
    }
    if (orConditions.length) query.$or = orConditions;
    const jobsRaw = await Job.find(query).sort(sort).limit(dbLimit).lean();
    for (const j of jobsRaw) j.id = j._id.toString();
    const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit, { userId: user?._id?.toString?.() || user?.id });
    if (rankedIds && rankedIds.paymentRequired) return { jobs: [], paymentRequired: true };
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
    return { jobs: rankedIds.map((id) => idToJob[id]).filter(Boolean), paymentRequired: false };
  }

  // Regular search with filters from AI
  const orConditions = [];

  if (filters.role) {
    const roleRegex = new RegExp(escapeRegex(filters.role), "i");
    orConditions.push(
      { title: roleRegex },
      { category: roleRegex },
      { description: roleRegex },
      { skills: roleRegex },
    );
  }

  if (filters.skills && Array.isArray(filters.skills) && filters.skills.length) {
    orConditions.push({ skills: { $in: filters.skills } });
  }

  if (filters.job_type) {
    query.jobType = new RegExp(escapeRegex(filters.job_type), "i");
  }

  if (filters.language) {
    query.languages = new RegExp(escapeRegex(filters.language), "i");
  }

  if (filters.salary_min) {
    const salMin = parseInt(filters.salary_min, 10);
    if (salMin > 0) query.salaryMax = { $gte: salMin };
  }

  if (filters.experience) {
    const exMatch = EXPERIENCE_LEVELS.find(e =>
      e.toLowerCase().includes(String(filters.experience).toLowerCase())
    );
    if (exMatch) query.experience = exMatch;
  }

  if (orConditions.length) {
    query.$or = orConditions;
  }

  if (filters.location) {
    query.location = new RegExp(escapeRegex(filters.location).replace(/\s+/g, "\\s+"), "i");
  }

  let jobsRaw = await Job.find(query).sort(sort).limit(dbLimit).lean();

  // Fallback: location was too strict, retry without it
  if (!jobsRaw.length && filters.location && query.$or) {
    const relaxed = { ...query };
    delete relaxed.location;
    jobsRaw = await Job.find(relaxed).sort(sort).limit(dbLimit).lean();
  }

  if (!jobsRaw.length) return { jobs: [], paymentRequired: false };

  for (const j of jobsRaw) j.id = j._id.toString();
  const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit, {
    userId: user?._id?.toString?.() || user?.id,
  });
  if (rankedIds && rankedIds.paymentRequired) return { jobs: [], paymentRequired: true };
  const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
  return { jobs: rankedIds.map((id) => idToJob[id]).filter(Boolean), paymentRequired: false };
}

/* ──────────────────── Employer: Find Candidates ──────────────────── */

async function executeFindCandidates(user) {
  const employerJobs = await Job.find({ employerId: user._id.toString(), status: "active" })
    .sort({ postedDate: -1 }).limit(5).lean();

  if (!employerJobs.length) {
    return { candidates: [], message: "You have no active jobs. Please post a job first!" };
  }

  const allJobSkills = [...new Set(employerJobs.flatMap(j => j.skills || []))];
  const allCategories = [...new Set(employerJobs.map(j => j.category).filter(Boolean))];

  const seekerQuery = { role: "seeker" };
  const orConds = [];
  if (allJobSkills.length) {
    orConds.push({ skills: { $in: allJobSkills } });
    orConds.push({ "aiExtracted.skills": { $in: allJobSkills } });
  }
  if (allCategories.length) {
    const catRegex = allCategories.map(escapeRegex).join("|");
    orConds.push({ "aiExtracted.category": new RegExp(catRegex, "i") });
  }
  if (orConds.length) seekerQuery.$or = orConds;

  const seekers = await User.find(seekerQuery).limit(30).lean();
  if (!seekers.length) {
    return { candidates: [], message: "No matching candidates right now. You'll see them when they register." };
  }

  for (const s of seekers) s.id = s._id.toString();
  const topJob = employerJobs[0];
  const rankedIds = await rankCandidatesForJob(topJob, seekers, 10, {
    userId: user?._id?.toString?.() || user?.id,
  });
  if (rankedIds && rankedIds.paymentRequired) {
    return { paymentRequired: true, candidates: [], message: MSG_AI_CREDITS_EXHAUSTED };
  }
  const idMap = Object.fromEntries(seekers.map(s => [s.id, s]));
  const ranked = rankedIds.map(id => idMap[id]).filter(Boolean);

  return {
    candidates: ranked.map(s => ({
      id: s.id,
      name: s.name,
      phone: s.phone,
      skills: [...new Set([...(s.skills || []), ...(s.aiExtracted?.skills || [])])],
      experience: s.aiExtracted?.experience || s.experience || "Fresher",
      location: s.location || "N/A",
    })),
    jobTitles: employerJobs.map(j => j.title),
  };
}

/* ──────────────────── STAGE 2: Format response (AI Call 2) ──────────────────── */

const FORMAT_SYSTEM = `You are Protibha, a warm job assistant for Kolkata Job Hub.

Language: You must reply in English only. Every word of your response must be in English. Do not use Bengali, Hindi, or any mixed language (no Banglish). This is required.

Format job results for the user. Rules:
- Use emojis sparingly but effectively.
- Show each job as a numbered card with: title, location, salary, business name.
- If no jobs found, be encouraging and suggest trying different keywords or "recent jobs".
- For apply confirmations, be celebratory and warm.
- For general chat, be helpful and concise (1-3 sentences).
- Keep the total response under 5 sentences for search results (the job cards are shown separately by the UI).
- NEVER make up job data. Only reference jobs from the provided results.
- Respond in a way that feels like chatting with a friend.
- If user previously applied to similar jobs, briefly acknowledge that.
- When user has salary preferences, mention if results match their range.`;

async function stage2_formatResponse(intent, results, context) {
  const { userId, userProfile, searchType, filters, applyResult, userMessage, similarJobsAfterApply } = context;

  let userPrompt = "";

  if (intent === "search" || intent === "similar") {
    const jobCount = results.length;
    const jobSummary = results.slice(0, 5).map((j, i) =>
      `${i + 1}. ${j.title || "Job"} at ${j.businessName || "Company"} – ${j.location || "Kolkata"} – ${j.salary || "Negotiable"}`
    ).join("\n");

    let searchDesc = "";
    if (searchType === "nearby") searchDesc = `near ${filters?.location || "their area"}`;
    else if (searchType === "skills_match") searchDesc = "matching their skills";
    else if (searchType === "highest_paying") searchDesc = "highest paying";
    else if (searchType === "similar") searchDesc = "similar to what they've applied for";
    else if (filters?.role) searchDesc = `for "${filters.role}"${filters.location ? ` in ${filters.location}` : ""}`;
    else searchDesc = "recent";

    const salaryCtx = userProfile?.preferredSalary?.min > 0
      ? `\nUser prefers salary range: ₹${userProfile.preferredSalary.min} - ₹${userProfile.preferredSalary.max}`
      : "";

    const prevAppsCtx = userProfile?.previousAppsCount > 0
      ? `\nUser has applied to ${userProfile.previousAppsCount} jobs before (categories: ${userProfile.appliedCategories?.join(", ") || "various"}).`
      : "";

    userPrompt = `User searched ${searchDesc}. Found ${jobCount} jobs.
${jobCount > 0 ? `Top results:\n${jobSummary}` : "No matching jobs found."}

User's profile: skills=${JSON.stringify(userProfile?.skills || [])}, location=${userProfile?.location || "N/A"}${salaryCtx}${prevAppsCtx}

Write a SHORT (1-2 sentences) intro message in English only. The job cards will be shown separately by the UI, so do NOT list the jobs again. Just say how many you found and a brief context.`;
  } else if (intent === "apply") {
    const { applied, alreadyApplied, failed, jobTitles } = applyResult;
    const hasSimilar = similarJobsAfterApply?.length > 0;
    userPrompt = `User wanted to apply. Results: ${applied} applied successfully, ${alreadyApplied} already applied, ${failed} failed.
Jobs: ${jobTitles.join(", ")}
${hasSimilar ? `\n${similarJobsAfterApply.length} similar jobs available.` : ""}

Write a SHORT (1-2 sentences) confirmation in English only. Be warm and encouraging. Mention the employer will contact them if applied successfully.${hasSimilar ? " Mention that similar jobs are shown below." : " Ask if they want similar jobs."}`;
  } else if (intent === "candidates") {
    const { candidates, jobTitles } = context.candidateResult;
    userPrompt = `Employer searched for candidates for their jobs: ${jobTitles?.join(", ") || "their posted jobs"}.
Found ${candidates.length} matching candidates.
${candidates.slice(0, 5).map((c, i) => `${i + 1}. ${c.name} – skills: ${c.skills?.join(", ")} – ${c.location}`).join("\n")}

Write a SHORT (1-2 sentences) intro in English only. Candidate cards are shown separately by the UI.`;
  } else {
    userPrompt = `User said: "${userMessage}"
User profile: skills=${JSON.stringify(userProfile?.skills || [])}, location=${userProfile?.location || "N/A"}
${userProfile?.previousAppsCount > 0 ? `They've applied to ${userProfile.previousAppsCount} jobs before.` : "They haven't applied to any jobs yet."}

Write a helpful, warm response in English only. If they seem to want jobs, suggest using the quick actions or typing a job category. 1-3 sentences max.`;
  }

  const { result: formatted, paymentRequired } = await aiText(FORMAT_SYSTEM, userPrompt, { userId, temperature: 0.6, maxTokens: 180 });
  if (paymentRequired) return { formatted: null, paymentRequired: true };
  return { formatted: formatted || "", paymentRequired: false };
}

/* ──────────────────── Apply flow (Mongoose) ──────────────────── */

function parseOrdinalIndex(text) {
  const t = normalize(text);
  if (/second|2nd|ditiyo|dwitio/i.test(t)) return 1;
  if (/third|3rd|tritiyo/i.test(t)) return 2;
  if (/fourth|4th/i.test(t)) return 3;
  if (/fifth|5th/i.test(t)) return 4;
  return 0;
}

async function fetchActiveJobsByIds(ids) {
  const validIds = ids.filter((id) => /^[a-f\d]{24}$/i.test(id));
  if (!validIds.length) return [];
  const objectIds = validIds.map((id) => toObjectId(id));
  const jobsRaw = await Job.find({ _id: { $in: objectIds }, status: "active" }).lean();
  for (const j of jobsRaw) j.id = j._id.toString();
  return jobsRaw;
}

async function executeApply(userId, user, applyTarget, contextJobIds) {
  const isAll = /all|sob|সব|all of them/i.test(applyTarget || "");
  const isById = typeof applyTarget === "string" && /^[a-f\d]{24}$/i.test(applyTarget);
  const ordinal = parseOrdinalIndex(applyTarget || "");

  let jobs = [];

  // (a) Explicit job ID
  if (isById) {
    const found = await fetchActiveJobsByIds([applyTarget]);
    if (found.length) jobs = found;
  }

  // (b) Use context (last shown jobs)
  if (!jobs.length && contextJobIds.length) {
    const contextJobs = await fetchActiveJobsByIds(contextJobIds);
    if (isAll) {
      jobs = contextJobs;
    } else if (contextJobs.length) {
      const idx = Math.min(Math.max(ordinal, 0), contextJobs.length - 1);
      jobs = [contextJobs[idx]];
    }
  }

  if (!jobs.length) {
    return { applied: 0, alreadyApplied: 0, failed: 0, jobTitles: [], appliedJobs: [] };
  }

  const toApply = isAll ? jobs : [jobs[0]];
  let applied = 0;
  let alreadyApplied = 0;
  let failed = 0;

  for (const job of toApply) {
    try {
      if (job.status !== "active") { failed++; continue; }

      const existing = await Application.findOne({ job: job._id || job.id, seeker: userId });
      if (existing) { alreadyApplied++; continue; }

      await Application.create({
        job: job._id || job.id,
        seeker: userId,
        seekerName: user.name,
        seekerPhone: user.phone,
        seekerSkills: user.skills || [],
        coverLetter: "",
        status: "pending",
        appliedDate: new Date(),
      });

      await Job.findByIdAndUpdate(job._id || job.id, { $inc: { applicationsCount: 1 } });
      applied++;
    } catch (e) {
      if (e.code === 11000) { alreadyApplied++; continue; }
      failed++;
    }
  }

  return {
    applied,
    alreadyApplied,
    failed,
    jobTitles: toApply.map((j) => j.title || "Job"),
    appliedJobs: toApply,
  };
}

/* ──────────────────── Employer flow (Mongoose) ──────────────────── */

function isEmployerCancel(text) {
  const t = normalize(text);
  return /^(exit|quit|cancel|stop|restart|reset|start over|clear)$/i.test(t) || /^\/(exit|quit|cancel|restart|reset|clear)$/i.test(t);
}

function isEmployerNegative(text) {
  const t = normalize(text);
  return /^(no|nah|nope|not now|later|না|nahin|nahi)$/i.test(t);
}

function isEmployerConfirm(text) {
  const t = normalize(text);
  return /^(yes|y|ok|okay|post|confirm|done|ঠিক আছে|হ্যাঁ|হাঁ)$/i.test(t);
}

function isValidSalaryText(salary) {
  const t = String(salary || "").trim().toLowerCase();
  if (!t) return false;
  if (/negotiable|as per|depends|tbd/.test(t)) return true;
  return /\d/.test(t);
}

function normalizeSalaryFromUserText(text) {
  const t = toAsciiDigits(String(text || "").trim());
  if (!t) return null;
  if (/negotiable|as per|depends|tbd/i.test(t)) return "Negotiable";

  const nums = t.match(/\d+/g)?.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0) || [];
  if (!nums.length) return null;

  // If numbers look like "6-7" or "6 7", interpret as thousands per month.
  const max = Math.max(...nums);
  const scaled = max < 1000 ? nums.map((n) => n * 1000) : nums;
  const lo = Math.min(...scaled);
  const hi = scaled.length >= 2 ? Math.max(...scaled) : lo;

  const fmt = (n) => `₹${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  if (lo === hi) return `${fmt(lo)}/month`;
  return `${fmt(lo)} - ${fmt(hi)}/month`;
}

/* ──────────────────── Employer: AI-driven conversational job posting ──────────────────── */

const JOB_POSTING_SCHEMA = {
  category:    { label: "Job Category",        allowed: JOB_CATEGORIES },
  location:    { label: "Location",            hint: "e.g. Garia, Salt Lake, Park Street" },
  salary:      { label: "Salary",              hint: "e.g. ₹8,000 - ₹12,000/month or Negotiable" },
  jobType:     { label: "Job Type",            allowed: JOB_TYPES },
  experience:  { label: "Experience Required", allowed: EXPERIENCE_LEVELS },
  description: { label: "Job Description",     hint: "Type 'skip' to skip" },
};

const EMPLOYER_QUESTION_GEN_SYSTEM = `You are Protibha, a friendly assistant for Kolkata Job Hub.
Generate warm, conversational questions to collect job posting details from an employer.
Each question must be short, friendly, and include a helpful hint with Kolkata-relevant examples.

Return ONLY valid JSON:
{
  "questions": [
    { "field": "category",    "question": "...", "hint": "..." },
    { "field": "location",    "question": "...", "hint": "..." },
    { "field": "salary",      "question": "...", "hint": "..." },
    { "field": "jobType",     "question": "...", "hint": "..." },
    { "field": "experience",  "question": "...", "hint": "..." },
    { "field": "description", "question": "...", "hint": "..." }
  ]
}

Generate exactly 6 questions in that field order. For description, remind the employer they can type 'skip'.`;

async function aiGenerateJobQuestions(userId, user) {
  const ctx = `Employer: ${user.name || "Employer"}, Business: ${user.businessName || "N/A"}, City: ${user.location || "Kolkata"}`;
  const { result, paymentRequired } = await aiJson(
    EMPLOYER_QUESTION_GEN_SYSTEM,
    `${ctx}\n\nGenerate job posting questions:`,
    { userId, maxTokens: 600 },
  );
  if (paymentRequired) return { questions: null, paymentRequired: true };

  const fallback = [
    { field: "category",    question: "What type of job are you posting? 💼",                      hint: "e.g. Sales, Delivery, Security, Beautician, Driver, Restaurant" },
    { field: "location",    question: "📍 Where is the job located?",                              hint: "e.g. Garia, Salt Lake, Park Street, Dum Dum" },
    { field: "salary",      question: "💰 What is the salary range?",                              hint: "e.g. ₹8,000 - ₹12,000/month or Negotiable" },
    { field: "jobType",     question: "Is this a Full-time or Part-time position?",                hint: "Type 'full' or 'part'" },
    { field: "experience",  question: "What experience level is required?",                        hint: "e.g. Fresher, 1-2 years, 3-5 years, 5+ years" },
    { field: "description", question: "📝 Briefly describe the job role and requirements.",        hint: "Type 'skip' to skip this step" },
  ];

  const valid = Array.isArray(result?.questions) && result.questions.length === 6;
  return { questions: valid ? result.questions : fallback, paymentRequired: false };
}

const EMPLOYER_ANSWER_VALIDATE_SYSTEM = `You are validating an employer's reply during a conversational job posting flow on Kolkata Job Hub.

Determine if the reply is:
- "answer": directly answering the current question (even if phrased informally or in mixed language)
- "general": general chat, greeting, question, or unrelated to the current question

Extraction and normalization rules:
- category: match to closest allowed value; MUST be from the allowed list.
- salary: small numbers like "6-7" mean thousands (₹6,000-₹7,000/month). Format as "₹X,XXX - ₹Y,YYY/month".
- jobType: normalize to exactly "Full-time" or "Part-time".
- experience: normalize to the closest allowed value.
- location: any area/locality name with 3+ characters is valid.
- description: any text 8+ chars is valid. "skip"/"no"/"na"/"n/a" → "See requirements."

Return ONLY valid JSON:
{
  "type": "answer|general",
  "extracted_value": "normalized value if answer, null if general",
  "valid": true,
  "validation_message": "brief reason if valid is false (omit if valid)",
  "reply": "short friendly response (acknowledge if answer, respond to chat if general)"
}`;

async function aiValidateEmployerAnswer(userId, field, question, hint, message) {
  const schemaField = JOB_POSTING_SCHEMA[field] || {};
  const allowed = schemaField.allowed
    ? `\nAllowed values for "${field}": ${JSON.stringify(schemaField.allowed)}`
    : "";

  const userPrompt = `Field: "${field}" (${schemaField.label || field})
Question asked: "${question}"
Hint: "${hint || ""}"${allowed}
Employer's reply: "${message}"

Classify and extract:`;

  const { result, paymentRequired } = await aiJson(
    EMPLOYER_ANSWER_VALIDATE_SYSTEM,
    userPrompt,
    { userId, maxTokens: 200 },
  );
  if (paymentRequired) return { type: null, paymentRequired: true };
  if (!result || typeof result !== "object") return { type: "general", reply: null, paymentRequired: false };
  return { ...result, paymentRequired: false };
}

const EMPLOYER_GENERAL_CHAT_SYSTEM = `You are Protibha, a smart business assistant for employers on Kolkata Job Hub.

You help employers with:
- Hiring advice and tips for Kolkata's job market
- Writing effective job descriptions for blue-collar and service roles
- Salary benchmarks for various roles in Kolkata
- How to attract more applicants to their job posts
- Platform features (job posting, finding candidates, etc.)

Reply in English, warmly and concisely (2-4 sentences max).
If they want to post a job, suggest /postJob.
If they want to find candidates, suggest /findCandidates.
If they want hiring tips, suggest /tips.`;

async function aiEmployerGeneralChat(userId, user, message, session) {
  const history = (session.messages || []).slice(-8).map(m => `${m.role}: ${m.content}`).join("\n");
  const userPrompt = `Employer: ${user.name || "Employer"}, Business: ${user.businessName || "N/A"}, Location: ${user.location || "Kolkata"}
Recent conversation:
${history}

Message: "${message}"`;

  const { result: reply, paymentRequired } = await aiText(
    EMPLOYER_GENERAL_CHAT_SYSTEM,
    userPrompt,
    { userId, temperature: 0.7, maxTokens: 200 },
  );
  if (paymentRequired) return { reply: null, paymentRequired: true };
  return {
    reply: reply || "I'm here to help! Post a job with /postJob, find candidates with /findCandidates, or ask me anything about hiring.",
    paymentRequired: false,
  };
}

function buildJobDraftSummary(answers) {
  return [
    "📋 Here's your job posting:",
    `• Category:    ${answers.category    || "?"}`,
    `• Location:    ${answers.location    || "?"}`,
    `• Salary:      ${answers.salary      || "?"}`,
    `• Type:        ${answers.jobType     || "?"}`,
    `• Experience:  ${answers.experience  || "?"}`,
    `• Description: ${answers.description || "See requirements."}`,
  ].join("\n");
}

async function finalizeJobPosting(userId, user, answers, session) {
  const draft = {
    category:    answers.category    || "",
    location:    answers.location    || "",
    salary:      answers.salary      || "",
    jobType:     answers.jobType     || "Full-time",
    experience:  answers.experience  || "Fresher",
    description: answers.description || "See requirements.",
  };

  const { errors, cat, jt, ex, desc } = validateJobDraft(draft);
  if (errors.length) {
    return {
      message: `Some details need fixing: ${errors.join(", ")}. Please start again with /postJob.`,
      action: "error",
    };
  }

  const title = `${cat} - ${draft.location}`;
  const recentDup = await Job.findOne({
    employerId: userId,
    title,
    location: draft.location,
    postedDate: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
  });
  if (recentDup) {
    return { message: "You just posted a similar job moments ago. Please wait a few minutes before posting again.", action: "error" };
  }

  const reservation = await reserveJobPostingQuota(userId);
  if (!reservation.ok) {
    return { message: MSG_JOB_POST_PAYMENT_REQUIRED, action: "payment_required" };
  }
  const employerWithCredit = reservation.user;

  const { salaryMin, salaryMax } = parseSalaryRange(draft.salary);
  let job;
  try {
    job = await Job.create({
      title,
      category: cat,
      description: desc || "See requirements.",
      salary: draft.salary,
      salaryMin,
      salaryMax,
      location: draft.location,
      jobType: jt || "Full-time",
      experience: ex || "Fresher",
      education: "Any",
      languages: ["Bengali", "Hindi", "English"],
      skills: [cat],
      employerId: userId,
      employerName: employerWithCredit.name,
      employerPhone: employerWithCredit.phone,
      businessName: employerWithCredit.businessName,
      postedDate: new Date(),
      status: "active",
      applicationsCount: 0,
      isPaid: reservation.source !== "free",
    });
  } catch (e) {
    await rollbackJobPostingQuota(userId, reservation.source);
    invalidateUserCache(userId);
    throw e;
  }
  invalidateUserCache(userId);
  await updateSessionMemory(session, { jobPostingFlow: null, jobDraft: null });

  const jobJson = job.toJSON();
  return {
    message: `🎉 Your job "${title}" is now live! Candidates can see and apply to it.`,
    action: "post_job_success",
    payload: { jobId: jobJson.id, job: jobJson },
  };
}

function sanitizeEnum(val, list) {
  if (!val) return null;
  return list.find((c) => c.toLowerCase() === String(val).toLowerCase()) || null;
}

function validateJobDraft(draft) {
  const errors = [];
  const cat = sanitizeEnum(draft.category, JOB_CATEGORIES);
  if (!cat) errors.push("Invalid category");
  if (!draft.location || String(draft.location).trim().length < 3) errors.push("Location required");
  if (!draft.salary || String(draft.salary).trim().length < 2) errors.push("Salary required");
  if (draft.salary && !isValidSalaryText(draft.salary)) errors.push("Salary invalid");
  const jt = sanitizeEnum(draft.jobType, JOB_TYPES);
  if (!jt) errors.push("Invalid job type");
  const ex = sanitizeEnum(draft.experience, EXPERIENCE_LEVELS);
  if (!ex) errors.push("Invalid experience");
  const desc = String(draft.description || "").trim();
  if (!desc || desc.length < MIN_DESCRIPTION_LEN || desc.length > MAX_DESCRIPTION_LEN) {
    errors.push("Description length invalid");
  }
  return { errors, cat, jt, ex, desc };
}

function parseSalaryRange(salary) {
  const cleaned = toAsciiDigits(String(salary || "")).replace(/,/g, "");
  const nums = cleaned.match(/\d+/g);
  if (!nums || nums.length === 0) return { salaryMin: 0, salaryMax: 0 };
  const parsed = nums.map(Number);
  return {
    salaryMin: parsed[0] || 0,
    salaryMax: parsed[1] || parsed[0] || 0,
  };
}

async function handleEmployerFlow(userId, lastContent, session) {
  const user = await User.findById(userId).lean();
  if (!user || user.role !== "employer") {
    return { message: "Only employers can use this feature.", action: "error" };
  }

  const flow = session?.memory?.jobPostingFlow;

  // Cancel at any time during the flow
  if (isEmployerCancel(lastContent)) {
    await updateSessionMemory(session, { jobPostingFlow: null, jobDraft: null });
    return {
      message: "Job posting cancelled. Start again anytime with /postJob, or ask me anything! 😊",
      action: "job_creation_cancelled",
      payload: { jobDraft: null },
    };
  }

  // /postJob entrypoint: lastContent === "" signals a fresh start
  if (lastContent === "") {
    const { questions, paymentRequired } = await aiGenerateJobQuestions(userId, user);
    if (paymentRequired) return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };

    const newFlow = { active: true, questions, currentIdx: 0, answers: {} };
    await updateSessionMemory(session, { jobPostingFlow: newFlow });

    const q = questions[0];
    const msg = `Let's post your job! I'll ask you ${questions.length} quick questions. 🚀\n\n${q.question}${q.hint ? `\n_(${q.hint})_` : ""}`;
    return {
      message: msg,
      action: "job_creation_step",
      payload: { nextStep: q.field, questionIdx: 0, totalQuestions: questions.length },
    };
  }

  // Active job posting flow
  if (flow?.active && Array.isArray(flow.questions) && flow.questions.length > 0) {
    const currentIdx = typeof flow.currentIdx === "number" ? flow.currentIdx : 0;

    // All questions answered → confirmation step
    if (currentIdx >= flow.questions.length) {
      if (isEmployerNegative(lastContent)) {
        await updateSessionMemory(session, { jobPostingFlow: null });
        return {
          message: "No problem! Start a new job post anytime with /postJob. 😊",
          action: "job_creation_cancelled",
          payload: { jobDraft: null },
        };
      }
      if (isEmployerConfirm(lastContent)) {
        return await finalizeJobPosting(userId, user, flow.answers, session);
      }
      // Not a clear yes/no – re-show summary
      const summary = buildJobDraftSummary(flow.answers);
      return {
        message: `${summary}\n\nReady to post? Reply yes to confirm or no to cancel.`,
        action: "job_creation_step",
        payload: { nextStep: "confirm", answers: flow.answers },
      };
    }

    const currentQ = flow.questions[currentIdx];

    // AI validates whether this message answers the current question or is general chat
    const validation = await aiValidateEmployerAnswer(
      userId,
      currentQ.field,
      currentQ.question,
      currentQ.hint || "",
      lastContent,
    );
    if (validation.paymentRequired) return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };

    // General chat – respond naturally and re-ask the pending question
    if (!validation || validation.type === "general") {
      const generalReply = validation?.reply ? `${validation.reply}\n\n` : "";
      const reask = `${currentQ.question}${currentQ.hint ? `\n_(${currentQ.hint})_` : ""}`;
      return {
        message: `${generalReply}${reask}`,
        action: "job_creation_step",
        payload: { nextStep: currentQ.field, questionIdx: currentIdx, totalQuestions: flow.questions.length },
      };
    }

    // Invalid answer – explain and re-ask
    if (validation.type === "answer" && !validation.valid) {
      const hintText = currentQ.hint ? `\n_(Hint: ${currentQ.hint})_` : "";
      return {
        message: `${validation.validation_message || "That doesn't look right."} Please try again.${hintText}\n\n${currentQ.question}`,
        action: "job_creation_step",
        payload: { nextStep: currentQ.field, questionIdx: currentIdx, totalQuestions: flow.questions.length },
      };
    }

    // Valid answer – store and advance to next question
    const value = validation.extracted_value || lastContent;
    const updatedAnswers = { ...flow.answers, [currentQ.field]: value };
    const nextIdx = currentIdx + 1;

    if (nextIdx >= flow.questions.length) {
      // All questions answered → show summary and ask for confirmation
      await updateSessionMemory(session, { jobPostingFlow: { ...flow, answers: updatedAnswers, currentIdx: nextIdx } });
      const summary = buildJobDraftSummary(updatedAnswers);
      return {
        message: `✅ All done!\n\n${summary}\n\nLooks good? Reply yes to post or no to cancel.`,
        action: "job_creation_step",
        payload: { nextStep: "confirm", answers: updatedAnswers },
      };
    }

    // Ask next question
    await updateSessionMemory(session, { jobPostingFlow: { ...flow, answers: updatedAnswers, currentIdx: nextIdx } });
    const nextQ = flow.questions[nextIdx];
    const ack = validation.reply ? `${validation.reply}\n\n` : "✅ Got it!\n\n";
    return {
      message: `${ack}${nextQ.question}${nextQ.hint ? `\n_(${nextQ.hint})_` : ""}`,
      action: "job_creation_step",
      payload: { nextStep: nextQ.field, questionIdx: nextIdx, totalQuestions: flow.questions.length },
    };
  }

  // No active job posting flow → general employer AI chat (AI credits deducted)
  const { reply, paymentRequired } = await aiEmployerGeneralChat(userId, user, lastContent, session);
  if (paymentRequired) return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
  return { message: reply || "How can I help you today? 😊", action: "message" };
}

/* ──────────────────── Local intent detection (fast fallback) ──────────────────── */

function detectLocalIntent(text) {
  const t = normalize(text);
  if (/apply|kore\s*dao|kore\s*de|diyo|aply/i.test(t)) return "apply";
  if (/similar|erokom|like\s*this|like\s*these|same\s*type/i.test(t)) return "similar";
  if (/find|search|khujo|dikhau|dikhay|jobs?\b|khuje|recent|latest|show|dekha|chai/i.test(t)) return "search";
  const categories = [
    /delivery|courier/, /beautician|beauty|parlour|salon/, /driver|driving/,
    /sales|sell/, /retail|shop/, /warehouse|packing/, /restaurant|cook|chef|kitchen|waiter/,
    /security|guard/, /hospitality|hotel/, /office|admin|clerk/,
    /medical|pharma|representative/, /teacher|tutor/, /nurse|nursing/,
  ];
  for (const cat of categories) {
    if (cat.test(t)) return "search";
  }
  return null;
}

/* ──────────────────── Fallback messages (when no AI available) ──────────────────── */

function fallbackSearchMessage(jobs, filters) {
  const desc = filters?.role || filters?.location || "search";
  if (!jobs.length) return `No jobs found for "${desc}". Try different keywords.`;
  return `Found ${jobs.length} job(s)${filters?.role ? ` for "${filters.role}"` : ""}${filters?.location ? ` in ${filters.location}` : ""}. See below:`;
}

function fallbackApplyMessage(result) {
  if (result.applied > 0 && result.alreadyApplied > 0) {
    return `Applied to ${result.applied} job(s)! (${result.alreadyApplied} already applied.)`;
  }
  if (result.applied > 0) return `Applied to ${result.applied} job(s)! Good luck! 🎉`;
  if (result.alreadyApplied > 0) return "You have already applied to this job(s).";
  return "Could not apply. Please search for jobs first.";
}

/* ──────────────────── Context helpers ──────────────────── */

function sanitizeContextJobs(lastJobs) {
  if (!Array.isArray(lastJobs)) return [];
  return lastJobs
    .map((j) => {
      const id = typeof j?.id === "string" ? j.id : typeof j?._id === "string" ? j._id : null;
      if (!id || !/^[a-f\d]{24}$/i.test(id)) return null;
      return id;
    })
    .filter(Boolean);
}

function sanitizeJobForClient(job) {
  const out = serializeDoc(job);
  delete out.employerPhone;
  return out;
}

/* ──────────────────── MAIN ENTRY POINT ──────────────────── */

export async function handleProtibhaChat(userId, role, messages, jobDraft = null, context = {}) {
  const user = await User.findById(userId).lean();
  if (!user) return { message: "User not found.", action: "error" };

  // Get or create server-side session
  const session = await getOrCreateSession(userId);

  const lastUser = messages.filter((m) => m.role === "user").pop();
  const lastContent = (lastUser?.content || "").trim();

  // Save user message to session
  if (lastContent) {
    await appendSessionMessage(session, "user", lastContent);
  }

  // Merge context job IDs: client-side lastJobs + server-side session.lastJobIds
  const clientJobIds = sanitizeContextJobs(context.lastJobs);
  const serverJobIds = (session.lastJobIds || []).map(id => id.toString());
  const contextJobIds = [...new Set([...clientJobIds, ...serverJobIds])];

  // Greeting (empty message)
  if (!lastContent) {
    const greeting = role === "seeker"
      ? "👋 Hi! I'm Protibha, your AI job assistant. I can find jobs and help you apply. What would you like to do?"
      : "👋 Hi! I'm Protibha. I'll help you post jobs. What kind of job do you want to post?";
    await appendSessionMessage(session, "assistant", greeting, "greeting");
    return { message: greeting, action: "greeting" };
  }

  // ═══════════════════ EMPLOYER FLOW ═══════════════════
  if (role === "employer") {
    if (isSlashCommand(lastContent)) {
      const profile = await buildUserProfile(user);
      const cmd = routeSlashCommand(lastContent, user, profile);

      // /postJob – start a fresh AI-driven job posting flow (no AI credits for the command itself)
      if (cmd.intent === "employer_post") {
        const result = await handleEmployerFlow(userId, "", session);
        await appendSessionMessage(session, "assistant", result.message, result.action);
        return result;
      }

      // /findCandidates – no AI credits deducted for the slash command
      if (cmd.intent === "employer_find_candidates") {
        const candResult = await executeFindCandidates(user);
        if (candResult.paymentRequired) {
          return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
        }
        if (!candResult.candidates.length) {
          await appendSessionMessage(session, "assistant", candResult.message, "message");
          return { message: candResult.message, action: "message" };
        }
        const { formatted, paymentRequired } = await stage2_formatResponse("candidates", [], {
          userId,
          userProfile: null,
          candidateResult: candResult,
          userMessage: lastContent,
        });
        if (paymentRequired) {
          return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
        }
        const msg = formatted || `Found ${candResult.candidates.length} matching candidates for your jobs.`;
        await appendSessionMessage(session, "assistant", msg, "show_candidates");
        return {
          message: msg,
          action: "show_candidates",
          payload: { candidates: candResult.candidates },
        };
      }

      // /tips – no AI credits deducted for the slash command trigger
      if (cmd.intent === "employer_tips") {
        const { result: tips, paymentRequired } = await aiText(
          "You are Protibha, a job posting expert for Kolkata businesses. Give 3-4 short, actionable tips for writing better job posts that attract more candidates. Write in English only. Be warm and practical.",
          `Employer: ${user.name}, business: ${user.businessName || "N/A"}, location: ${user.location || "Kolkata"}`,
          { userId, temperature: 0.6, maxTokens: 180 },
        );
        if (paymentRequired) {
          return { message: MSG_AI_CREDITS_TRY_AGAIN, action: "payment_required" };
        }
        const msg = tips || "Good job posts have a clear title, salary range, and location—candidates apply more when details are clear.";
        await appendSessionMessage(session, "assistant", msg, "message");
        return { message: msg, action: "message" };
      }
    }

    // All non-slash messages: active job posting flow or general employer AI chat
    const result = await handleEmployerFlow(userId, lastContent, session);
    await appendSessionMessage(session, "assistant", result.message, result.action);
    return result;
  }

  // ═══════════════════ SEEKER FLOW ═══════════════════
  const userProfile = await buildUserProfile(user);

  // Helper to build response and persist
  async function buildSearchResponse(jobs, searchType, filters) {
    const serialized = jobs.map(sanitizeJobForClient);
    const { formatted, paymentRequired } = await stage2_formatResponse("search", serialized, {
      userId,
      userProfile,
      searchType,
      filters,
      userMessage: lastContent,
    });
    if (paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    const msg = formatted || fallbackSearchMessage(serialized, filters);

    // Update session with shown job IDs
    const jobIds = serialized.map(j => {
      try { return toObjectId(j.id); } catch { return null; }
    }).filter(Boolean);
    await updateSessionMemory(session, {
      lastJobIds: jobIds,
      lastSearchFilters: filters,
      preferredLocation: filters?.location || session.memory.preferredLocation,
      preferredCategory: filters?.role || session.memory.preferredCategory,
    });
    await appendSessionMessage(session, "assistant", msg, "show_jobs", { jobCount: serialized.length });

    return {
      message: msg,
      action: "show_jobs",
      payload: { jobs: serialized },
    };
  }

  // ─── STEP 1: Route slash commands (no AI cost) ───
  if (isSlashCommand(lastContent)) {
    const cmd = routeSlashCommand(lastContent, user, userProfile);

    if (cmd.intent === "search") {
      const searchResult = await executeJobSearch(user, cmd.filters, cmd.searchType, userProfile);
      if (searchResult.paymentRequired) {
        await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
        return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
      }
      return buildSearchResponse(searchResult.jobs, cmd.searchType, cmd.filters);
    }
    if (cmd.intent === "build_resume") {
      const msg = "📝 Let's build your ATS-optimized resume! Tap the button below to open the Resume Builder.";
      await appendSessionMessage(session, "assistant", msg, "build_resume");
      return { message: msg, action: "build_resume" };
    }
  }

  // ─── STEP 2: Detect intent (local first, then AI) ───
  let intent = detectLocalIntent(lastContent);
  let filters = {};
  let applyTarget = null;

  if (intent === "search") {
    const stage1 = await stage1_classifyIntent(userId, lastContent, userProfile, messages);
    if (stage1.paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    const s1 = stage1.intentResult;
    filters = s1.filters || {};
    if (s1.intent === "apply") {
      intent = "apply";
      applyTarget = s1.apply_target;
    }
  } else if (intent === "apply") {
    const stage1 = await stage1_classifyIntent(userId, lastContent, userProfile, messages);
    if (stage1.paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    applyTarget = stage1.intentResult?.apply_target || lastContent;
  } else if (intent === "similar") {
    // Use similar search directly
  } else {
    const stage1 = await stage1_classifyIntent(userId, lastContent, userProfile, messages);
    if (stage1.paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    const s1 = stage1.intentResult;
    intent = s1.intent || "general";
    filters = s1.filters || {};
    applyTarget = s1.apply_target || null;
  }

  // ─── STEP 3: Execute intent ───

  if (intent === "search" || intent === "find") {
    const searchResult = await executeJobSearch(user, filters, "filtered", userProfile);
    if (searchResult.paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    return buildSearchResponse(searchResult.jobs, "filtered", filters);
  }

  if (intent === "similar") {
    const searchResult = await executeJobSearch(user, {}, "similar", userProfile);
    if (searchResult.paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    const serialized = searchResult.jobs.map(sanitizeJobForClient);
    const { formatted, paymentRequired } = await stage2_formatResponse("similar", serialized, {
      userId,
      userProfile,
      searchType: "similar",
      filters: {},
      userMessage: lastContent,
    });
    if (paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    const msg = formatted || (serialized.length
      ? `Found ${serialized.length} similar job(s)!`
      : "No similar jobs right now. Try different keywords.");

    const jobIds = serialized.map(j => {
      try { return toObjectId(j.id); } catch { return null; }
    }).filter(Boolean);
    await updateSessionMemory(session, { lastJobIds: jobIds });
    await appendSessionMessage(session, "assistant", msg, "show_jobs");

    return {
      message: msg,
      action: "show_jobs",
      payload: { jobs: serialized },
    };
  }

  if (intent === "apply") {
    const result = await executeApply(userId, user, applyTarget, contextJobIds);

    if (!result.applied && !result.alreadyApplied && !result.failed) {
      const msg = "No jobs to apply to. Search for jobs first, then say \"apply\"! 💡";
      await appendSessionMessage(session, "assistant", msg, "show_jobs");
      return { message: msg, action: "show_jobs", payload: { jobs: [] } };
    }

    // After successful apply, find similar jobs automatically
    let similarJobs = [];
    if (result.applied > 0) {
      try {
        // Refresh profile (new application added)
        const freshProfile = await buildUserProfile(user);
        const simResult = await executeJobSearch(user, {}, "similar", freshProfile, { rankLimit: 5 });
        if (!simResult.paymentRequired && simResult.jobs) {
          similarJobs = simResult.jobs.map(sanitizeJobForClient);
        }
      } catch { /* ignore */ }
    }

    const { formatted, paymentRequired } = await stage2_formatResponse("apply", [], {
      userId,
      userProfile,
      applyResult: result,
      userMessage: lastContent,
      similarJobsAfterApply: similarJobs,
    });
    if (paymentRequired) {
      await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
      return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
    }
    const msg = formatted || fallbackApplyMessage(result);
    await appendSessionMessage(session, "assistant", msg, "apply_success");

    // Update session with similar job IDs
    if (similarJobs.length) {
      const jobIds = similarJobs.map(j => {
        try { return toObjectId(j.id); } catch { return null; }
      }).filter(Boolean);
      await updateSessionMemory(session, { lastJobIds: jobIds });
    }

    return {
      message: msg,
      action: "apply_success",
      payload: {
        applied: result.applied,
        jobs: result.appliedJobs.map(sanitizeJobForClient),
        similarJobs,
      },
    };
  }

  // ─── GENERAL / FALLBACK ───
  const { formatted: generalReply, paymentRequired } = await stage2_formatResponse("general", [], {
    userId,
    userProfile,
    userMessage: lastContent,
  });
  if (paymentRequired) {
    await appendSessionMessage(session, "assistant", MSG_AI_CREDITS_EXHAUSTED, "payment_required");
    return { message: MSG_AI_CREDITS_EXHAUSTED, action: "payment_required" };
  }
  const msg = generalReply || "Ami bujhte parlam na. Jobs khujte \"delivery jobs\" ba \"find jobs\" bolen! 🔍";
  await appendSessionMessage(session, "assistant", msg, "message");

  return { message: msg, action: "message" };
}
