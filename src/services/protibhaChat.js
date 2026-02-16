/**
 * Protibha – unified conversational AI assistant for Kolkata Job Hub.
 * Handles: job search, apply, create job (Q&A flow) for seekers and employers.
 */
import OpenAI from "openai";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { rankJobsForSeeker } from "./ai.js";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_AVAILABLE = !!process.env.OPENAI_API_KEY;

function getClient() {
  if (!OPENAI_AVAILABLE) return null;
  try {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch {
    return null;
  }
}

function parseJsonFromResponse(raw) {
  if (!raw?.trim()) return null;
  raw = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const JOB_CATEGORIES = ["Sales", "Delivery", "Retail", "Hospitality", "Office Work", "Driver", "Warehouse", "Restaurant", "Security", "Beautician", "Other"];
const JOB_TYPES = ["Full-time", "Part-time"];
const EXPERIENCE_LEVELS = ["Fresher", "1-2 years", "3-5 years", "5+ years"];
const MAX_DESCRIPTION_LEN = 2000;
const MIN_DESCRIPTION_LEN = 8;

function getNextJobStep(jobDraft) {
  if (!jobDraft.category || jobDraft.category === "?") return "category";
  if (!jobDraft.location || jobDraft.location === "?") return "location";
  if (!jobDraft.salary || jobDraft.salary === "?") return "salary";
  if (!jobDraft.jobType || jobDraft.jobType === "?") return "jobType";
  if (!jobDraft.experience || jobDraft.experience === "?") return "experience";
  if (!jobDraft.description || jobDraft.description === "?") return "description";
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
    const format = (n) => (n >= 1000 ? `₹${n / 1000},000` : `₹${n}`);
    return `${format(lo)} - ${format(hi)}/month`;
  }
  return null;
}

function parseEmployerResponse(step, userText, jobDraft) {
  const text = (userText || "").trim();
  if (!text) return { ...jobDraft };

  const next = { ...jobDraft };

  switch (step) {
    case "category":
      next.category = resolveCategory(text) || jobDraft.category || "Other";
      break;
    case "location":
      next.location = text || jobDraft.location || "Kolkata";
      break;
    case "salary":
      next.salary = extractSalary(text) || text || jobDraft.salary || "₹10,000 - ₹15,000/month";
      break;
    case "jobType":
      const jt = JOB_TYPES.find((x) => text.toLowerCase().includes(x.toLowerCase().replace("-", "")));
      next.jobType = jt || (text.toLowerCase().includes("part") ? "Part-time" : "Full-time");
      break;
    case "experience":
      const ex = EXPERIENCE_LEVELS.find((x) => text.toLowerCase().includes(x.toLowerCase()));
      next.experience = ex || "Fresher";
      break;
    case "description":
      if (/no|skip|na|nahi/i.test(text)) next.description = "See requirements.";
      else next.description = text || jobDraft.description || "See requirements.";
      break;
    default:
      break;
  }
  return next;
}

/**
 * Build seeker system prompt – ONLY for intent classification, not for generating user-facing replies.
 */
function buildSeekerSystem(user) {
  const skills = [...new Set([...(user.skills || []), ...(user.aiExtracted?.skills || [])])];
  const exp = user.aiExtracted?.experience || user.experience || "Fresher";
  const loc = user.location || "";
  return `You are an intent classifier for a job platform chat. The user is a JOB SEEKER.
User profile: skills=${JSON.stringify(skills)}, experience=${exp}, location=${loc}

Classify the user's message into ONE of these intents:
- "search" – user wants to find/browse/see jobs (e.g. "beautician jobs", "find me delivery jobs", "show recent jobs")
- "apply" – user wants to apply to a job (e.g. "apply to the first one", "apply to all")
- "general" – general question, greeting, or unrelated to job search/apply

Extract the search_query (the key terms to search for, e.g. "beautician", "delivery in salt lake").
Extract apply_target if intent is apply ("first", "all", or a job ID).

Respond ONLY with valid JSON. Keys: intent, search_query, apply_target.
Do NOT generate any user-facing reply or job count. Do NOT hallucinate data.`;
}

function escapeRegex(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSearchInput(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\biin\b/g, " in ")
    .replace(/\bslat\s+lake\b/g, "salt lake")
    .replace(/\bsaltlake\b/g, "salt lake")
    .replace(/\bdelivary\b/g, "delivery")
    .replace(/\bdeliver\b/g, "delivery")
    .replace(/\s+/g, " ")
    .trim();
}

function getCategoryHint(text) {
  const t = normalizeSearchInput(text);
  if (/delivery|courier|pickup|drop/.test(t)) return "Delivery";
  if (/beautician|beauty|parlour|salon/.test(t)) return "Beautician";
  if (/driver|driving/.test(t)) return "Driver";
  if (/sales|sell/.test(t)) return "Sales";
  if (/retail|shop/.test(t)) return "Retail";
  if (/warehouse|packing|picker/.test(t)) return "Warehouse";
  if (/restaurant|cook|chef|kitchen|waiter/.test(t)) return "Restaurant";
  if (/security|guard/.test(t)) return "Security";
  if (/hospitality|hotel/.test(t)) return "Hospitality";
  if (/office|admin|clerk/.test(t)) return "Office Work";
  return null;
}

function sanitizeCategory(cat) {
  if (!cat) return null;
  const found = JOB_CATEGORIES.find((c) => c.toLowerCase() === String(cat).toLowerCase());
  return found || null;
}

function sanitizeJobType(jt) {
  if (!jt) return null;
  const found = JOB_TYPES.find((c) => c.toLowerCase() === String(jt).toLowerCase().replace("-", ""));
  return found || null;
}

function sanitizeExperience(ex) {
  if (!ex) return null;
  const found = EXPERIENCE_LEVELS.find((c) => c.toLowerCase() === String(ex).toLowerCase());
  return found || null;
}

function sanitizeLastJobs(contextLastJobs) {
  if (!Array.isArray(contextLastJobs)) return [];
  return contextLastJobs
    .map((j) => {
      const id = typeof j?.id === "string" ? j.id : typeof j?._id === "string" ? j._id : null;
      if (!id || !/^[a-f\\d]{24}$/i.test(id)) return null;
      return { id };
    })
    .filter(Boolean);
}

async function fetchActiveJobsByIds(db, ids) {
  const validIds = ids.filter((id) => /^[a-f\\d]{24}$/i.test(id));
  if (!validIds.length) return [];
  const objectIds = validIds.map((id) => toObjectId(id));
  const jobsRaw = await db.collection("jobs").find({ _id: { $in: objectIds }, status: "active" }).toArray();
  for (const j of jobsRaw) j.id = j._id.toString();
  return jobsRaw;
}

function parseOrdinalIndex(text) {
  const t = normalizeSearchInput(text);
  if (/second|2nd|ditiyo/i.test(t)) return 1;
  if (/third|3rd|tritiyo/i.test(t)) return 2;
  if (/fourth|4th|choththo/i.test(t)) return 3;
  return 0; // default to first when ordinal mentioned; caller decides whether to use
}

function validateEmployerJobDraft(draft) {
  const errors = [];
  const cat = sanitizeCategory(draft.category);
  if (!cat) errors.push("Invalid category");
  if (!draft.location || String(draft.location).trim().length < 2) errors.push("Location required");
  if (!draft.salary || String(draft.salary).trim().length < 2) errors.push("Salary required");
  const jt = sanitizeJobType(draft.jobType);
  if (!jt) errors.push("Invalid job type");
  const ex = sanitizeExperience(draft.experience);
  if (!ex) errors.push("Invalid experience");
  const desc = String(draft.description || "").trim();
  if (!desc || desc.length < MIN_DESCRIPTION_LEN || desc.length > MAX_DESCRIPTION_LEN) {
    errors.push("Description length invalid");
  }
  return { errors, cat, jt, ex, desc };
}

function getLocationHint(text, generatedLocation) {
  const normalized = normalizeSearchInput(text);
  const match = normalized.match(/\b(?:in|at|near)\s+([a-z ]{3,40})(?:\bfor\b|\bwith\b|$)/i);
  let location = (match?.[1] || "").trim();
  if (!location && generatedLocation) location = normalizeSearchInput(generatedLocation);
  if (!location) return null;
  return location.replace(/\bjobs?\b/g, "").trim() || null;
}

const SEEKER_QUERY_STOP_WORDS = new Set([
  "find", "search", "show", "jobs", "job", "recent", "latest", "new", "me",
  "in", "at", "near", "for", "please", "a", "the", "all", "iin",
  "khujo", "dikhau", "dikhay", "chai", "want", "need", "give",
]);

/**
 * Search for jobs matching the query. Returns ONLY genuinely matching jobs.
 * If nothing matches, returns empty array – does NOT fall back to unrelated jobs.
 */
async function searchJobsForSeeker(db, user, queryText, { dbLimit = 30, rankLimit = 10 } = {}) {
  const normalized = normalizeSearchInput(queryText);
  const recentOnly = /recent|latest|new|akhon|sob|all/.test(normalized);

  // If user just wants recent/all jobs, return them directly
  if (recentOnly && !getCategoryHint(normalized)) {
    const jobsRaw = await db.collection("jobs").find({ status: "active" }).sort({ postedDate: -1 }).limit(dbLimit).toArray();
    for (const j of jobsRaw) j.id = j._id.toString();
    const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit);
    const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
    return rankedIds.map((id) => idToJob[id]).filter(Boolean);
  }

  // Try to extract category and location hints (only from user text, no LLM guess)
  const categoryHint = getCategoryHint(normalized);
  const locationHint = getLocationHint(normalized, user.location);

  // Build the search query
  const primaryQuery = { status: "active" };

  if (categoryHint) {
    const categoryRegex = new RegExp(escapeRegex(categoryHint), "i");
    primaryQuery.$or = [
      { category: categoryRegex },
      { title: categoryRegex },
      { description: categoryRegex },
      { skills: categoryRegex },
    ];
  } else if (normalized.length > 2) {
    const tokens = normalized
      .split(/\s+/)
      .filter((w) => w.length > 2 && !SEEKER_QUERY_STOP_WORDS.has(w))
      .slice(0, 5);
    if (tokens.length) {
      const tokenRegex = new RegExp(tokens.map(escapeRegex).join("|"), "i");
      primaryQuery.$or = [
        { title: tokenRegex },
        { category: tokenRegex },
        { description: tokenRegex },
        { skills: tokenRegex },
      ];
    }
  }

  if (locationHint) {
    primaryQuery.location = new RegExp(escapeRegex(locationHint).replace(/\s+/g, "\\s+"), "i");
  }

  let jobsRaw = await db.collection("jobs").find(primaryQuery).sort({ postedDate: -1 }).limit(dbLimit).toArray();

  // Fallback: if strict location caused zero results, retry without location
  // but KEEP the category/keyword filter so we only return relevant jobs
  if (!jobsRaw.length && primaryQuery.location && primaryQuery.$or) {
    const withoutLocation = { ...primaryQuery };
    delete withoutLocation.location;
    jobsRaw = await db.collection("jobs").find(withoutLocation).sort({ postedDate: -1 }).limit(dbLimit).toArray();
  }

  // NO Fallback 2: if still empty, return empty. Don't return random unrelated jobs.
  if (!jobsRaw.length) {
    return [];
  }

  for (const j of jobsRaw) j.id = j._id.toString();
  const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit);
  const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
  return rankedIds.map((id) => idToJob[id]).filter(Boolean);
}

/**
 * Detect intent locally from text (fast, no LLM needed for obvious cases).
 */
function detectLocalIntent(text) {
  const t = normalizeSearchInput(text);
  if (/apply|kore\s*dao|kore\s*de|diyo|aply/i.test(t)) return "apply";
  if (/find|search|khujo|dikhau|dikhay|jobs?\b|khuje|recent|latest|show|dekha|chai/i.test(t)) return "search";
  // Check if text mentions a known category (implicit search)
  if (getCategoryHint(t)) return "search";
  return null;
}

/**
 * Build a user-facing search result message based on ACTUAL results.
 */
function buildSearchResultMessage(jobs, searchTerm) {
  const term = searchTerm || "search";
  if (jobs.length === 0) {
    return `"${term}" diye kono job khuje paini. Onno category ba keyword try koren, ba "recent jobs" bolen sob dekhte.`;
  }
  if (jobs.length === 1) {
    return `"${term}" diye 1 ti job peyechi. Ekhane dekhen:`;
  }
  return `"${term}" diye ${jobs.length} ti job peyechi. Ekhane dekhen:`;
}

/**
 * Main chat handler: routes by role, performs actions, returns response.
 */
export async function handleProtibhaChat(userId, role, messages, jobDraft = null, context = {}) {
  const db = getDb();
  const user = await db.collection("users").findOne({ _id: toObjectId(userId) });
  if (!user) return { message: "User not found.", action: "error" };

  const lastUser = messages.filter((m) => m.role === "user").pop();
  const lastContent = (lastUser?.content || "").trim();
  if (!lastContent) {
    const greeting = role === "seeker"
      ? "Hi! I'm Protibha. How can I help you today? Ami apnar profile onujayi jobs khuje dite pari. বলুন আপনি কি খুঁজছেন?"
      : "Hi! I'm Protibha. How can I help you today? Ami apnake job post korte sahajjo korbo – ki rokom chakri post korben?";
    return { message: greeting, action: "greeting" };
  }

  // ===== EMPLOYER: job creation flow =====
  if (role === "employer") {
    const draft = jobDraft || {
      category: "?",
      location: "?",
      salary: "?",
      jobType: "?",
      experience: "?",
      description: "?",
    };

    const step = getNextJobStep(draft);
    const updatedDraft = parseEmployerResponse(step, lastContent, draft);

    const confirmWords = /yes|হ্যাঁ|হাঁ|ok|post|করুন|korum|confirm|ঠিক আছে/i;
    if (step === "confirm" && confirmWords.test(lastContent)) {
      const employer = await db.collection("users").findOne({ _id: toObjectId(userId) });
      if (!employer || employer.role !== "employer") {
        return { message: "Only employers can post jobs.", action: "error" };
      }
      const remaining = Number.isFinite(employer?.freeJobsRemaining) ? employer.freeJobsRemaining : 0;
      if (remaining <= 0) {
        return {
          message: "Apnar free job post sesh. Payment required.",
          action: "payment_required",
        };
      }
      const { errors, cat, jt, ex, desc } = validateEmployerJobDraft(updatedDraft);
      if (errors.length) {
        return { message: `Job details invalid: ${errors.join(", ")}`, action: "error" };
      }

      const title = `${updatedDraft.category} - ${updatedDraft.location}`.replace(/\?/g, "Kolkata");
      // Prevent accidental duplicate spam (same employer + title + location in last 5 minutes)
      const recentDup = await db.collection("jobs").findOne({
        employerId: userId,
        title,
        location: updatedDraft.location,
        postedDate: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
      });
      if (recentDup) {
        return { message: "You just posted a similar job moments ago.", action: "error" };
      }

      const jobDoc = {
        title: title,
        category: cat,
        description: desc || "See requirements.",
        salary: updatedDraft.salary,
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
      };
      await db.collection("jobs").insertOne(jobDoc);
      await db.collection("users").updateOne(
        { _id: toObjectId(userId) },
        { $inc: { freeJobsRemaining: -1 } }
      );
      const jobId = jobDoc._id.toString();
      return {
        message: `Job posted successfully! Ami "${title}" post kore diyechi. Candidates apply korte parbe.`,
        action: "post_job_success",
        payload: { jobId, job: serializeDoc({ ...jobDoc, id: jobId }) },
      };
    }

    const nextStep = getNextJobStep(updatedDraft);
    const prompts = {
      category: "What kind of job would you like to post? (e.g. Beautician, Sales, Delivery, Retail)",
      location: "Kothay location hobe? (e.g. Garia, Park Street, Salt Lake)",
      salary: "Salary range koto? (e.g. ₹10,000 - ₹15,000/month)",
      jobType: "Full-time na Part-time?",
      experience: "Experience level? (Fresher, 1-2 years, 3-5 years, 5+ years)",
      description: "Kichhu extra bolun description er jonno. (Optional - skip with 'no' or 'skip')",
      confirm: `Here's your job: ${updatedDraft.category} at ${updatedDraft.location}, ${updatedDraft.salary}. Post korbo?`,
    };
    const reply = prompts[nextStep];
    return {
      message: reply,
      action: "job_creation_step",
      payload: { jobDraft: updatedDraft, nextStep },
    };
  }

  // ===== SEEKER: job search and apply =====
  if (role === "seeker") {
    // Step 1: Try to detect intent locally (fast, no LLM call needed)
    let intent = detectLocalIntent(lastContent);
    let searchQuery = lastContent;
    let applyTarget = null;
    const contextJobs = sanitizeLastJobs(context.lastJobs);
    const contextJobIds = contextJobs.map((j) => j.id);

    // Step 2: If local detection fails, use LLM for intent classification only
    if (!intent) {
      const client = getClient();
      if (client) {
        try {
          const system = buildSeekerSystem(user);
          const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
          history.unshift({ role: "system", content: system });

          const completion = await client.chat.completions.create({
            model: OPENAI_MODEL,
            messages: history,
            temperature: 0.2,
            response_format: { type: "json_object" },
          });
          const raw = (completion.choices[0]?.message?.content || "").trim();
          const parsed = parseJsonFromResponse(raw) || {};

          intent = (parsed.intent || "general").toLowerCase();
          if (parsed.search_query || parsed.searchQuery) {
            searchQuery = parsed.search_query || parsed.searchQuery;
          }
          applyTarget = parsed.apply_target || parsed.applyTarget || null;
        } catch (err) {
          console.error("LLM intent classification failed:", err.message);
          intent = "search"; // Default to search on LLM failure
        }
      } else {
        intent = "search"; // No LLM available, default to search
      }
    }

    // Step 3: Execute the intent with REAL data
    if (intent === "search" || intent === "find") {
      const wantsNearMe = /\bnear me\b|\bnearby\b|amar kache|pasher|pash[eé]/i.test(searchQuery || lastContent);
      let effectiveQuery = searchQuery;

      if (wantsNearMe) {
        const loc = (user.location || "").trim();
        effectiveQuery = loc ? `jobs in ${loc}` : "recent jobs";
      }

      let jobs = (await searchJobsForSeeker(db, user, effectiveQuery)).map((j) => serializeDoc(j));

      // If user asked "near me" but no results, fall back to recent active jobs
      if (!jobs.length && wantsNearMe) {
        jobs = (await searchJobsForSeeker(db, user, "recent jobs")).map((j) => serializeDoc(j));
      }

      const displayTerm = extractSearchDisplayTerm(effectiveQuery);
      const msg = buildSearchResultMessage(jobs, displayTerm);

      return {
        message: msg,
        action: "show_jobs",
        payload: { jobs },
      };
    }

    if (intent === "apply") {
      // First decide which jobs to target
      const applyTargetId = typeof applyTarget === "string" && /^[a-f\\d]{24}$/i.test(applyTarget) ? applyTarget : null;
      const ordinalRequested = parseOrdinalIndex(applyTarget || lastContent);
      const applyAll = /all|sob|সব|all of them/i.test(lastContent) || applyTarget === "all";
      let jobs = [];

      // (a) If explicit job ID given, prioritize it
      if (applyTargetId) {
        const fromContext = contextJobIds.includes(applyTargetId)
          ? (await fetchActiveJobsByIds(db, [applyTargetId]))[0]
          : null;
        if (fromContext) jobs = [fromContext];
        else {
          const job = await db.collection("jobs").findOne({ _id: toObjectId(applyTargetId), status: "active" });
          if (job) { job.id = job._id.toString(); jobs = [job]; }
        }
      }

      // (b) If no explicit ID but we have context list, use it (all or ordinal)
      if (!jobs.length && contextJobIds.length) {
        const contextJobsFull = await fetchActiveJobsByIds(db, contextJobIds);
        if (applyAll) {
          jobs = contextJobsFull;
        } else if (contextJobsFull.length) {
          const idx = Math.min(Math.max(ordinalRequested, 0), contextJobsFull.length - 1);
          jobs = [contextJobsFull[idx]];
        }
      }

      // (c) Fallback: search again from text
      if (!jobs.length) {
        jobs = await searchJobsForSeeker(db, user, searchQuery);
      }

      if (!jobs.length) {
        return {
          message: "Kono job khuje paini apply korar jonno. Age \"find jobs\" ba ekta category bolen.",
          action: "show_jobs",
          payload: { jobs: [] },
        };
      }

      const toApply = applyAll ? jobs : [jobs[0]];

      let applied = 0;
      let alreadyApplied = 0;
      let failed = 0;
      for (const job of toApply) {
        try {
          if (job.status !== "active") { failed++; continue; }
          const existing = await db.collection("applications").findOne({ jobId: job.id, seekerId: userId });
          if (existing) { alreadyApplied++; continue; }
          const app = {
            jobId: job.id,
            coverLetter: "",
            seekerId: userId,
            seekerName: user.name,
            seekerPhone: user.phone,
            seekerSkills: user.skills || [],
            status: "pending",
            appliedDate: new Date(),
          };
          await db.collection("applications").insertOne(app);
          await db.collection("jobs").updateOne(
            { _id: toObjectId(job.id) },
            { $inc: { applicationsCount: 1 } }
          );
          applied++;
        } catch {
          failed++;
        }
      }

      let msg;
      if (applied > 0 && alreadyApplied > 0) {
        msg = `${applied} ti job e apply korechi! (${alreadyApplied} te already apply kora chhilo.) Good luck!`;
      } else if (applied > 0) {
        msg = `${applied} ti job e apply kore diyechi! Good luck!`;
      } else if (alreadyApplied > 0) {
        msg = "Apni already ei job(s) e apply korechen.";
      } else {
        msg = "Apply korte parlam na. Abar try koren.";
      }

      return {
        message: msg,
        action: "apply_success",
        payload: { applied, jobs: toApply.map((j) => serializeDoc(j)) },
      };
    }

    // General / fallback: use LLM for a conversational reply (no job data hallucination)
    const client = getClient();
    if (client) {
      try {
        const system = `You are Protibha, a friendly Bengali-English job assistant for Kolkata Job Hub.
The user is a job seeker. Help them with general questions.
Be warm, concise, use a mix of English and Bengali (Banglish).
Do NOT mention specific job counts or claim to have found jobs.
If they seem to want jobs, suggest they say "find [category] jobs" or "recent jobs".
Keep replies to 1-3 sentences.`;
        const history = messages.slice(-4).map((m) => ({ role: m.role, content: m.content }));
        history.unshift({ role: "system", content: system });

        const completion = await client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: history,
          temperature: 0.6,
          max_tokens: 150,
        });
        const reply = (completion.choices[0]?.message?.content || "").trim();
        if (reply) {
          return { message: reply, action: "message" };
        }
      } catch (err) {
        console.error("LLM fallback reply failed:", err.message);
      }
    }

    return {
      message: "Ami bujhte parlam na. Apni bolen: \"find delivery jobs\" ba \"recent jobs\" – ami khuje debo!",
      action: "message",
    };
  }

  return { message: "How can I help you today?", action: "message" };
}

/**
 * Extract a clean display term from the search query (remove stop words).
 */
function extractSearchDisplayTerm(query) {
  const normalized = normalizeSearchInput(query);
  const tokens = normalized
    .split(/\s+/)
    .filter((w) => w.length > 1 && !SEEKER_QUERY_STOP_WORDS.has(w));
  return tokens.join(" ") || query;
}
