/**
 * Protibha – unified conversational AI assistant for Kolkata Job Hub.
 * Handles: job search, apply, create job (Q&A flow) for seekers and employers.
 */
import OpenAI from "openai";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { rankJobsForSeeker, generateJobFromText } from "./ai.js";

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

/**
 * Determine next missing field for job creation and extract value from user message.
 */
function getNextJobStep(jobDraft) {
  if (!jobDraft.category || jobDraft.category === "?") return "category";
  if (!jobDraft.location || jobDraft.location === "?") return "location";
  if (!jobDraft.salary || jobDraft.salary === "?") return "salary";
  if (!jobDraft.jobType || jobDraft.jobType === "?") return "jobType";
  if (!jobDraft.experience || jobDraft.experience === "?") return "experience";
  if (!jobDraft.description || jobDraft.description === "?") return "description";
  return "confirm";
}

/**
 * Map free text to category (fuzzy match).
 */
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

/**
 * Extract salary from text like "12 to 15 thousand", "₹10000".
 */
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

/**
 * Parse employer response to fill job draft.
 */
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
 * Build seeker system prompt with user context.
 */
function buildSeekerSystem(user) {
  const skills = [...new Set([...(user.skills || []), ...(user.aiExtracted?.skills || [])])];
  const exp = user.aiExtracted?.experience || user.experience || "Fresher";
  const loc = user.location || "";
  return `You are Protibha, a friendly Bengali-English job assistant for Kolkata Job Hub. The user is a JOB SEEKER.
User profile: skills=${JSON.stringify(skills)}, experience=${exp}, location=${loc}

You help seekers:
1. Find jobs - "find me recent jobs", "delivery jobs in salt lake", "beautician jobs"
2. Apply to jobs - "apply to the first one", "apply to all", "apply to job X"

Be warm, concise, use a mix of English and Bengali (Banglish) when natural. Keep replies short (1-3 sentences).
When showing jobs, say how many you found and that they're based on their profile.
When they want to apply, confirm which job(s) before applying.`;
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
  return null;
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
]);

async function getRankedJobsForSeeker(db, user, queryText, { dbLimit = 30, rankLimit = 10 } = {}) {
  const normalized = normalizeSearchInput(queryText);
  const recentOnly = /recent|latest|new|akhon/.test(normalized);
  const generated = await generateJobFromText(normalized, user.location || "Kolkata");
  let categoryHint = getCategoryHint(normalized);
  if (!categoryHint && generated.category && generated.category !== "Other") {
    categoryHint = generated.category;
  }
  const locationHint = recentOnly ? null : getLocationHint(normalized, generated.location);

  const primaryQuery = { status: "active" };

  if (categoryHint) {
    const categoryRegex = new RegExp(escapeRegex(categoryHint), "i");
    primaryQuery.$or = [
      { category: categoryRegex },
      { title: categoryRegex },
      { description: categoryRegex },
      { skills: categoryRegex },
    ];
  } else if (!recentOnly && normalized.length > 2) {
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

  // Fallback 1: if strict location caused zero, retry without location.
  if (!jobsRaw.length && primaryQuery.location) {
    const withoutLocation = { ...primaryQuery };
    delete withoutLocation.location;
    jobsRaw = await db.collection("jobs").find(withoutLocation).sort({ postedDate: -1 }).limit(dbLimit).toArray();
  }

  // Fallback 2: if still empty, return recent active jobs and rely on ranking.
  if (!jobsRaw.length && (primaryQuery.$or || primaryQuery.location)) {
    jobsRaw = await db.collection("jobs").find({ status: "active" }).sort({ postedDate: -1 }).limit(dbLimit).toArray();
  }

  for (const j of jobsRaw) j.id = j._id.toString();
  const rankedIds = await rankJobsForSeeker(user, jobsRaw, rankLimit);
  const idToJob = Object.fromEntries(jobsRaw.map((j) => [j.id, j]));
  return rankedIds.map((id) => idToJob[id]).filter(Boolean);
}

/**
 * Main chat handler: routes by role, performs actions, returns response.
 */
export async function handleProtibhaChat(userId, role, messages, jobDraft = null) {
  const db = getDb();
  const user = await db.collection("users").findOne({ _id: toObjectId(userId) });
  if (!user) return { message: "User not found.", action: "error" };

  const lastUser = messages.filter((m) => m.role === "user").pop();
  const lastContent = (lastUser?.content || "").trim();
  if (!lastContent) {
    const greeting = role === "seeker"
      ? "Hi! I'm Protibha. How can I help you today? Ami apnar profile onujayi jobs khuje dite pari. বলুন আপনি কি খুঁজছেন?"
      : "Hi! I'm Protibha. How can I help you today? Ami apnake job post korte sahajjo korbo. Ki khaben – ki rokom chakri post korben?";
    return { message: greeting, action: "greeting" };
  }

  // Employer: job creation flow
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

    // Check for confirm
    const confirmWords = /yes|হ্যাঁ|হাঁ|ok|post|করুন|korum|confirm|ঠিক আছে/i;
    if (step === "confirm" && confirmWords.test(lastContent)) {
      const employer = await db.collection("users").findOne({ _id: toObjectId(userId) });
      if (!employer || employer.role !== "employer") {
        return { message: "Only employers can post jobs.", action: "error" };
      }
      if (employer.freeJobsRemaining <= 0) {
        return {
          message: "Apnar free job post sesh. Payment required.",
          action: "payment_required",
        };
      }
      const title = `${updatedDraft.category} - ${updatedDraft.location}`.replace(/\?/g, "Kolkata");
      const jobDoc = {
        title: title,
        category: updatedDraft.category,
        description: updatedDraft.description || "See requirements.",
        salary: updatedDraft.salary,
        location: updatedDraft.location,
        jobType: updatedDraft.jobType || "Full-time",
        experience: updatedDraft.experience || "Fresher",
        education: "Any",
        languages: ["Bengali", "Hindi", "English"],
        skills: [updatedDraft.category],
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

  // Seeker: job search and apply
  if (role === "seeker") {
    const client = getClient();
    if (!client) {
      return { message: "AI service unavailable. Please try the search tab.", action: "error" };
    }

    const system = buildSeekerSystem(user) + "\n\nRespond only with valid JSON. Keys: intent (search/find/apply/general), reply, search_query, apply_target when relevant.";
    const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    history.unshift({ role: "system", content: system });

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: history,
      temperature: 0.4,
      response_format: { type: "json_object" },
    });
    const raw = (completion.choices[0]?.message?.content || "").trim();
    const parsed = parseJsonFromResponse(raw) || {};

    const intent = (parsed.intent || "").toLowerCase();
    const searchQuery = parsed.search_query || parsed.searchQuery || lastContent;
    const applyTarget = parsed.apply_target || parsed.applyTarget; // "first", "all", jobId

    console.log("intent", intent, "searchQuery", searchQuery, "applyTarget", applyTarget)

    // Job search
    if (intent.includes("search") || intent.includes("find") || /find|search|khujo|dikhau|jobs?|dikhay|recent/i.test(lastContent)) {
      const combined = searchQuery || lastContent;
      console.log("combined", combined)
      const jobs = (await getRankedJobsForSeeker(db, user, combined)).map((j) => serializeDoc(j));

      const msg = jobs.length > 0
        ? `Ami ${jobs.length} ti job khunje peyechi apnar profile onujayi. Ekhane dekhen:`
        : `Kono job khuje paini "${searchQuery || "search"}". Onno kichhu try koren.`;
      return {
        message: msg,
        action: "show_jobs",
        payload: { jobs },
      };
    }

    // Apply to job(s)
    if (intent.includes("apply") || /apply|kore dao|kore de|diyo/i.test(lastContent)) {
      const combined = searchQuery || lastContent;
      const jobs = await getRankedJobsForSeeker(db, user, combined);

      if (jobs.length === 0) {
        return { message: "Kono job khuje paini. Age kichhu jobs khunje nin.", action: "show_jobs", payload: { jobs: [] } };
      }

      const applyAll = /all|sob|সব|all of them/i.test(lastContent) || applyTarget === "all";
      const toApply = applyAll ? jobs : [jobs[0]];

      let applied = 0;
      let failed = 0;
      for (const job of toApply) {
        try {
          const existing = await db.collection("applications").findOne({ jobId: job.id, seekerId: userId });
          if (existing) continue;
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

      const msg = applied > 0
        ? `Ami ${applied} ti job e apply kore diyechi. Good luck!`
        : failed > 0 ? "Apply korte parlam na. Abar try koren." : "Apni already apply korechen.";
      return {
        message: msg,
        action: "apply_success",
        payload: { applied, jobs: toApply.map((j) => serializeDoc(j)) },
      };
    }

    // Fallback: use LLM for natural reply
    const fallbackReply = parsed.reply || parsed.message || "Ami bujhte parlam na. Bollen: jobs khujo na apply korbo?";
    return {
      message: fallbackReply,
      action: "message",
    };
  }

  return { message: "How can I help you today?", action: "message" };
}
