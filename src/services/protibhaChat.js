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
import { rankJobsForSeeker, rankCandidatesForJob } from "./ai.js";
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

async function aiJson(systemPrompt, userPrompt, opts = {}) {
  const client = getClient();
  if (!client) return null;
  try {
    const r = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: opts.temperature ?? 0.2,
      response_format: { type: "json_object" },
      max_tokens: opts.maxTokens ?? 300,
    });
    return parseJson(r.choices[0]?.message?.content || "");
  } catch (e) {
    logger.error({ err: e.message }, "AI JSON call failed");
    return null;
  }
}

async function aiText(systemPrompt, userPrompt, opts = {}) {
  const client = getClient();
  if (!client) return null;
  try {
    const r = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens ?? 400,
    });
    return (r.choices[0]?.message?.content || "").trim();
  } catch (e) {
    logger.error({ err: e.message }, "AI text call failed");
    return null;
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
  if (updates.jobDraft !== undefined) session.jobDraft = updates.jobDraft;
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

async function stage1_classifyIntent(userMessage, userProfile, conversationHistory) {
  const profileCtx = `User profile: skills=${JSON.stringify(userProfile.skills)}, experience=${userProfile.experience}, location=${userProfile.location}, salary_pref=${JSON.stringify(userProfile.preferredSalary)}`;
  const historyCtx = conversationHistory.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");

  const userPrompt = `${profileCtx}

Recent conversation:
${historyCtx}

Current message: "${userMessage}"

Return JSON:`;

  const result = await aiJson(INTENT_SYSTEM, userPrompt);
  return result || { intent: "general", filters: {}, apply_target: null, raw_search: userMessage };
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
    const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit);
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
    return rankedIds.map((id) => idToJob[id]).filter(Boolean);
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
    const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit);
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
    return rankedIds.map((id) => idToJob[id]).filter(Boolean);
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
    const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit);
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
    return rankedIds.map((id) => idToJob[id]).filter(Boolean);
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

  if (!jobsRaw.length) return [];

  for (const j of jobsRaw) j.id = j._id.toString();
  const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit);
  const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
  return rankedIds.map((id) => idToJob[id]).filter(Boolean);
}

/* ──────────────────── Employer: Find Candidates ──────────────────── */

async function executeFindCandidates(user) {
  const employerJobs = await Job.find({ employerId: user._id.toString(), status: "active" })
    .sort({ postedDate: -1 }).limit(5).lean();

  if (!employerJobs.length) {
    return { candidates: [], message: "Apnar kono active job nai. Age ekta job post korun!" };
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
    return { candidates: [], message: "Ekhon kono matching candidate paini. Tara jokohn register korbe, dekhte paben." };
  }

  for (const s of seekers) s.id = s._id.toString();
  const topJob = employerJobs[0];
  const rankedIds = await rankCandidatesForJob(topJob, seekers, 10);
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

const FORMAT_SYSTEM = `You are Protibha, a warm Bengali-English job assistant for Kolkata Job Hub.

Format job results beautifully for the user. Rules:
- Use a mix of English and Bengali (Banglish) naturally.
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
  const { userProfile, searchType, filters, applyResult, userMessage, similarJobsAfterApply } = context;

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

Write a SHORT (1-2 sentences) intro message. The job cards will be shown separately by the UI, so do NOT list the jobs again. Just say how many you found and a brief context.`;
  } else if (intent === "apply") {
    const { applied, alreadyApplied, failed, jobTitles } = applyResult;
    const hasSimilar = similarJobsAfterApply?.length > 0;
    userPrompt = `User wanted to apply. Results: ${applied} applied successfully, ${alreadyApplied} already applied, ${failed} failed.
Jobs: ${jobTitles.join(", ")}
${hasSimilar ? `\n${similarJobsAfterApply.length} similar jobs available.` : ""}

Write a SHORT (1-2 sentences) confirmation. Be warm and encouraging. Mention the employer will contact them if applied successfully.${hasSimilar ? " Mention that similar jobs are shown below." : " Ask if they want similar jobs."}`;
  } else if (intent === "candidates") {
    const { candidates, jobTitles } = context.candidateResult;
    userPrompt = `Employer searched for candidates for their jobs: ${jobTitles?.join(", ") || "their posted jobs"}.
Found ${candidates.length} matching candidates.
${candidates.slice(0, 5).map((c, i) => `${i + 1}. ${c.name} – skills: ${c.skills?.join(", ")} – ${c.location}`).join("\n")}

Write a SHORT (1-2 sentences) intro. Candidate cards are shown separately by the UI.`;
  } else {
    userPrompt = `User said: "${userMessage}"
User profile: skills=${JSON.stringify(userProfile?.skills || [])}, location=${userProfile?.location || "N/A"}
${userProfile?.previousAppsCount > 0 ? `They've applied to ${userProfile.previousAppsCount} jobs before.` : "They haven't applied to any jobs yet."}

Write a helpful, warm response. If they seem to want jobs, suggest using the quick actions or typing a job category. 1-3 sentences max.`;
  }

  const formatted = await aiText(FORMAT_SYSTEM, userPrompt, { temperature: 0.6, maxTokens: 250 });
  return formatted;
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

function getNextJobStep(draft) {
  if (!draft.category || draft.category === "?") return "category";
  if (!draft.location || draft.location === "?") return "location";
  if (!draft.salary || draft.salary === "?") return "salary";
  if (!draft.jobType || draft.jobType === "?") return "jobType";
  if (!draft.experience || draft.experience === "?") return "experience";
  if (!draft.description || draft.description === "?") return "description";
  return "confirm";
}

function resolveCategory(text) {
  const t = (text || "").toLowerCase().trim();
  for (const c of JOB_CATEGORIES) {
    if (c.toLowerCase().includes(t) || t.includes(c.toLowerCase())) return c;
  }
  if (/beautician|beauty|parlour|salon/i.test(t)) return "Beautician";
  if (/sales|sell/i.test(t)) return "Sales";
  if (/delivery|deliver/i.test(t)) return "Delivery";
  if (/driver|drive/i.test(t)) return "Driver";
  if (/retail|shop/i.test(t)) return "Retail";
  if (/restaurant|food|cook|kitchen/i.test(t)) return "Restaurant";
  return text?.trim() || null;
}

function extractSalary(text) {
  const t = (text || "").toLowerCase();
  const match = t.match(/(\d+)\s*(?:to|-|–)\s*(\d+)\s*(?:thousand|k|000)?/i) ||
    t.match(/(\d+)\s*(?:thousand|k)/i) ||
    t.match(/₹?\s*(\d+)\s*(?:,\d+)*/);
  if (match) {
    const a = parseInt(match[1], 10);
    const b = match[2] ? parseInt(match[2], 10) : a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const fmt = (n) => (n >= 1000 ? `₹${n / 1000},000` : `₹${n}`);
    return `${fmt(lo)} - ${fmt(hi)}/month`;
  }
  return null;
}

function parseEmployerResponse(step, userText, draft) {
  const text = (userText || "").trim();
  if (!text) return { ...draft };
  const next = { ...draft };
  switch (step) {
    case "category":
      next.category = resolveCategory(text) || draft.category || "Other";
      break;
    case "location":
      next.location = text || draft.location || "Kolkata";
      break;
    case "salary":
      next.salary = extractSalary(text) || text || draft.salary || "₹10,000 - ₹15,000/month";
      break;
    case "jobType": {
      const jt = JOB_TYPES.find((x) => text.toLowerCase().includes(x.toLowerCase().replace("-", "")));
      next.jobType = jt || (text.toLowerCase().includes("part") ? "Part-time" : "Full-time");
      break;
    }
    case "experience": {
      const ex = EXPERIENCE_LEVELS.find((x) => text.toLowerCase().includes(x.toLowerCase()));
      next.experience = ex || "Fresher";
      break;
    }
    case "description":
      if (/no|skip|na|nahi/i.test(text)) next.description = "See requirements.";
      else next.description = text || draft.description || "See requirements.";
      break;
    default:
      break;
  }
  return next;
}

function sanitizeEnum(val, list) {
  if (!val) return null;
  return list.find((c) => c.toLowerCase() === String(val).toLowerCase()) || null;
}

function validateJobDraft(draft) {
  const errors = [];
  const cat = sanitizeEnum(draft.category, JOB_CATEGORIES);
  if (!cat) errors.push("Invalid category");
  if (!draft.location || String(draft.location).trim().length < 2) errors.push("Location required");
  if (!draft.salary || String(draft.salary).trim().length < 2) errors.push("Salary required");
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
  const nums = String(salary || "").match(/\d+/g);
  if (!nums || nums.length === 0) return { salaryMin: 0, salaryMax: 0 };
  const parsed = nums.map(Number);
  return {
    salaryMin: parsed[0] || 0,
    salaryMax: parsed[1] || parsed[0] || 0,
  };
}

async function handleEmployerFlow(userId, lastContent, jobDraft, session) {
  const draft = jobDraft || session?.jobDraft || {
    category: "?", location: "?", salary: "?",
    jobType: "?", experience: "?", description: "?",
  };

  const step = getNextJobStep(draft);
  const updatedDraft = parseEmployerResponse(step, lastContent, draft);

  const confirmWords = /yes|হ্যাঁ|হাঁ|ok|post|করুন|korum|confirm|ঠিক আছে/i;
  if (step === "confirm" && confirmWords.test(lastContent)) {
    const employer = await User.findById(userId);
    if (!employer || employer.role !== "employer") {
      return { message: "Only employers can post jobs.", action: "error" };
    }
    const remaining = Number.isFinite(employer?.freeJobsRemaining) ? employer.freeJobsRemaining : 0;
    if (remaining <= 0) {
      return { message: "Apnar free job post sesh. Payment required.", action: "payment_required" };
    }
    const { errors, cat, jt, ex, desc } = validateJobDraft(updatedDraft);
    if (errors.length) {
      return { message: `Job details invalid: ${errors.join(", ")}`, action: "error" };
    }

    const title = `${updatedDraft.category} - ${updatedDraft.location}`.replace(/\?/g, "Kolkata");
    const recentDup = await Job.findOne({
      employerId: userId,
      title,
      location: updatedDraft.location,
      postedDate: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
    });
    if (recentDup) return { message: "You just posted a similar job moments ago.", action: "error" };

    const { salaryMin, salaryMax } = parseSalaryRange(updatedDraft.salary);

    const job = await Job.create({
      title,
      category: cat,
      description: desc || "See requirements.",
      salary: updatedDraft.salary,
      salaryMin,
      salaryMax,
      location: updatedDraft.location,
      jobType: jt || "Full-time",
      experience: ex || "Fresher",
      education: "Any",
      languages: ["Bengali", "Hindi", "English"],
      skills: [cat],
      employerId: userId,
      employerName: employer.name,
      employerPhone: employer.phone,
      businessName: employer.businessName,
      postedDate: new Date(),
      status: "active",
      applicationsCount: 0,
    });

    employer.freeJobsRemaining -= 1;
    await employer.save();

    // Clear the draft from session
    if (session) await updateSessionMemory(session, { jobDraft: null });

    const jobJson = job.toJSON();
    return {
      message: `🎉 Job posted! "${title}" post kore diyechi. Candidates apply korte parbe.`,
      action: "post_job_success",
      payload: { jobId: jobJson.id, job: jobJson },
    };
  }

  // Save draft to session for continuity
  if (session) await updateSessionMemory(session, { jobDraft: updatedDraft });

  const nextStep = getNextJobStep(updatedDraft);
  const prompts = {
    category: "Ki rokom job post korben? (e.g. Beautician, Sales, Delivery, Retail)",
    location: "📍 Kothay location hobe? (e.g. Garia, Park Street, Salt Lake)",
    salary: "💰 Salary range koto? (e.g. ₹10,000 - ₹15,000/month)",
    jobType: "Full-time na Part-time?",
    experience: "Experience level? (Fresher, 1-2 years, 3-5 years, 5+ years)",
    description: "Kichhu extra bolun description er jonno. (Optional - 'skip' bolte paren)",
    confirm: `📋 Your job: ${updatedDraft.category} at ${updatedDraft.location}, ${updatedDraft.salary}. Post korbo?`,
  };
  return {
    message: prompts[nextStep],
    action: "job_creation_step",
    payload: { jobDraft: updatedDraft, nextStep },
  };
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
  if (!jobs.length) return `"${desc}" diye kono job khuje paini. Onno keyword try koren!`;
  return `${jobs.length} ti job peyechi${filters?.role ? ` "${filters.role}"` : ""}${filters?.location ? ` in ${filters.location}` : ""}. Ekhane dekhen:`;
}

function fallbackApplyMessage(result) {
  if (result.applied > 0 && result.alreadyApplied > 0) {
    return `${result.applied} ti job e apply korechi! (${result.alreadyApplied} te already apply kora chhilo.)`;
  }
  if (result.applied > 0) return `${result.applied} ti job e apply kore diyechi! Good luck! 🎉`;
  if (result.alreadyApplied > 0) return "Apni already ei job(s) e apply korechen.";
  return "Apply korte parlam na. Age kichhu jobs khunje nin.";
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
      ? "👋 Hi! I'm Protibha, apnar AI job assistant! Jobs khunje dite pari, apply korte pari. Ki korben bolen?"
      : "👋 Hi! I'm Protibha! Ami apnake job post korte sahajjo korbo. Ki rokom job post korben?";
    await appendSessionMessage(session, "assistant", greeting, "greeting");
    return { message: greeting, action: "greeting" };
  }

  // ═══════════════════ EMPLOYER FLOW ═══════════════════
  if (role === "employer") {
    if (isSlashCommand(lastContent)) {
      const profile = await buildUserProfile(user);
      const cmd = routeSlashCommand(lastContent, user, profile);

      if (cmd.intent === "employer_post") {
        const result = await handleEmployerFlow(userId, "", jobDraft, session);
        await appendSessionMessage(session, "assistant", result.message, result.action);
        return result;
      }
      if (cmd.intent === "employer_find_candidates") {
        const candResult = await executeFindCandidates(user);
        if (!candResult.candidates.length) {
          await appendSessionMessage(session, "assistant", candResult.message, "message");
          return { message: candResult.message, action: "message" };
        }
        const formatted = await stage2_formatResponse("candidates", [], {
          userProfile: null, candidateResult: candResult, userMessage: lastContent,
        });
        const msg = formatted || `${candResult.candidates.length} jon matching candidate peyechi apnar jobs er jonno!`;
        await appendSessionMessage(session, "assistant", msg, "show_candidates");
        return {
          message: msg,
          action: "show_candidates",
          payload: { candidates: candResult.candidates },
        };
      }
      if (cmd.intent === "employer_tips") {
        const tips = await aiText(
          "You are Protibha, a job posting expert for Kolkata businesses. Give 3-4 short, actionable tips for writing better job posts that attract more candidates. Use Banglish (Bengali + English mix). Be warm and practical.",
          `Employer: ${user.name}, business: ${user.businessName || "N/A"}, location: ${user.location || "Kolkata"}`,
          { temperature: 0.6, maxTokens: 300 },
        );
        const msg = tips || "Good job posts e clear title, salary range, ar location dile candidates beshi apply kore!";
        await appendSessionMessage(session, "assistant", msg, "message");
        return { message: msg, action: "message" };
      }
    }
    const result = await handleEmployerFlow(userId, lastContent, jobDraft, session);
    await appendSessionMessage(session, "assistant", result.message, result.action);
    return result;
  }

  // ═══════════════════ SEEKER FLOW ═══════════════════
  const userProfile = await buildUserProfile(user);

  // Helper to build response and persist
  async function buildSearchResponse(jobs, searchType, filters) {
    const serialized = jobs.map(serializeDoc);
    const formatted = await stage2_formatResponse("search", serialized, {
      userProfile, searchType, filters, userMessage: lastContent,
    });
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
      const jobs = await executeJobSearch(user, cmd.filters, cmd.searchType, userProfile);
      return buildSearchResponse(jobs, cmd.searchType, cmd.filters);
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
    const stage1 = await stage1_classifyIntent(lastContent, userProfile, messages);
    filters = stage1.filters || {};
    if (stage1.intent === "apply") {
      intent = "apply";
      applyTarget = stage1.apply_target;
    }
  } else if (intent === "apply") {
    const stage1 = await stage1_classifyIntent(lastContent, userProfile, messages);
    applyTarget = stage1.apply_target || lastContent;
  } else if (intent === "similar") {
    // Use similar search directly
  } else {
    const stage1 = await stage1_classifyIntent(lastContent, userProfile, messages);
    intent = stage1.intent || "general";
    filters = stage1.filters || {};
    applyTarget = stage1.apply_target || null;
  }

  // ─── STEP 3: Execute intent ───

  if (intent === "search" || intent === "find") {
    const jobs = await executeJobSearch(user, filters, "filtered", userProfile);
    return buildSearchResponse(jobs, "filtered", filters);
  }

  if (intent === "similar") {
    const jobs = await executeJobSearch(user, {}, "similar", userProfile);
    const serialized = jobs.map(serializeDoc);
    const formatted = await stage2_formatResponse("similar", serialized, {
      userProfile, searchType: "similar", filters: {}, userMessage: lastContent,
    });
    const msg = formatted || (serialized.length
      ? `${serialized.length} ti similar job peyechi!`
      : "Similar job ekhon paini. Onno keyword try koren!");

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
      const msg = "Kono job nai apply korar jonno. Age jobs khujen, tarpor \"apply\" bolen! 💡";
      await appendSessionMessage(session, "assistant", msg, "show_jobs");
      return { message: msg, action: "show_jobs", payload: { jobs: [] } };
    }

    // After successful apply, find similar jobs automatically
    let similarJobs = [];
    if (result.applied > 0) {
      try {
        // Refresh profile (new application added)
        const freshProfile = await buildUserProfile(user);
        similarJobs = (await executeJobSearch(user, {}, "similar", freshProfile, { rankLimit: 5 }))
          .map(serializeDoc);
      } catch { /* ignore */ }
    }

    const formatted = await stage2_formatResponse("apply", [], {
      userProfile, applyResult: result, userMessage: lastContent,
      similarJobsAfterApply: similarJobs,
    });

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
        jobs: result.appliedJobs.map(serializeDoc),
        similarJobs,
      },
    };
  }

  // ─── GENERAL / FALLBACK ───
  const generalReply = await stage2_formatResponse("general", [], {
    userProfile, userMessage: lastContent,
  });

  const msg = generalReply || "Ami bujhte parlam na. Jobs khujte \"delivery jobs\" ba \"find jobs\" bolen! 🔍";
  await appendSessionMessage(session, "assistant", msg, "message");

  return { message: msg, action: "message" };
}
