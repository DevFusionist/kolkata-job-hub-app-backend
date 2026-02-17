import OpenAI from "openai";
import logger from "../lib/logger.js";

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
    return null;
  }
}

async function chatJson(system, userContent) {
  const c = getClient();
  if (!c) return null;
  try {
    const r = await c.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });
    const raw = (r.choices[0]?.message?.content || "").trim();
    return raw ? parseJsonFromResponse(raw) : null;
  } catch (e) {
    logger.warn({ err: e.message }, "OpenAI chat failed");
    return null;
  }
}

export async function analyzePortfolio(rawText, projects = [], links = []) {
  const defaultOut = {
    skills: [],
    experience: "Fresher",
    category: "Other",
    score: 0,
    feedback: "Unable to analyze. Add more details about your work.",
  };
  if (!rawText && !projects?.length && !links?.length) return defaultOut;
  let content = `Resume/Portfolio text:\n${rawText || "None"}\n`;
  if (projects?.length) content += `\nProjects: ${projects.join(", ")}\n`;
  if (links?.length) content += `\nLinks: ${links.join(", ")}\n`;
  if (!OPENAI_AVAILABLE) return defaultOut;
  const system = `You are a talent analyst for a local Kolkata job platform. Analyze the portfolio/resume and extract:
1. skills: list of specific skills (e.g. React, Sales, Driving, Cooking)
2. experience: "Fresher" or "1-2 years" or "3-5 years" or "5+ years"
3. category: job category - Sales, Delivery, Retail, Hospitality, Office Work, Driver, Warehouse, Restaurant, Security, Other
4. score: 0-100 talent score based on clarity, skills, experience
5. feedback: 1-2 sentence improvement tips (skill gap, what to add). Be encouraging. In English.
Output ONLY valid JSON with keys: skills, experience, category, score, feedback.`;
  const data = await chatJson(system, `${content}\nReturn JSON only:`);
  if (!data) return defaultOut;
  let skills = data.skills || [];
  if (typeof skills === "string") skills = skills.split(",").map((s) => s.trim()).filter(Boolean);
  else if (!Array.isArray(skills)) skills = [];
  return {
    skills: skills.slice(0, 20),
    experience: data.experience || "Fresher",
    category: data.category || "Other",
    score: Math.min(100, Math.max(0, parseInt(data.score, 10) || 0)),
    feedback: data.feedback || defaultOut.feedback,
  };
}

export async function generateJobFromText(text, employerLocation) {
  const defaultOut = {
    title: "",
    category: "Other",
    description: "",
    salary: "₹10,000 - ₹15,000/month",
    location: employerLocation || "Kolkata",
    jobType: "Full-time",
    experience: "Fresher",
    education: "Any",
    languages: ["Bengali", "Hindi", "English"],
    skills: [],
  };
  if (!text || text.trim().length < 5) return defaultOut;
  if (!OPENAI_AVAILABLE) return defaultOut;
  const system = `You are a job posting assistant for Kolkata businesses. Convert the employer's casual text into a structured job post.
Output ONLY valid JSON with: title, category, description, salary, location, jobType (Full-time or Part-time), experience (Fresher, 1-2 years, 3-5 years, 5+ years), education (Any, 10th Pass, 12th Pass, Graduate, Post Graduate), languages (array), skills (array).
Categories: Sales, Delivery, Retail, Hospitality, Office Work, Driver, Warehouse, Restaurant, Security, Other.
If location missing, use Kolkata. Salary format: ₹X,000 - ₹Y,000/month. Keep description concise.`;
  const prompt = `Employer text: "${text}"\nDefault location: ${employerLocation || "Kolkata"}\nReturn JSON only:`;
  const data = await chatJson(system, prompt);
  if (!data) return defaultOut;
  let skills = data.skills || [];
  if (typeof skills === "string") skills = skills.split(",").map((s) => s.trim()).filter(Boolean);
  else if (!Array.isArray(skills)) skills = [];
  let langs = data.languages || ["Bengali", "Hindi", "English"];
  if (typeof langs === "string") langs = langs.split(",").map((l) => l.trim()).filter(Boolean);
  return {
    title: (data.title || "").trim() || "Job Position",
    category: data.category || "Other",
    description: (data.description || "").trim() || "See requirements.",
    salary: (data.salary || "").trim() || defaultOut.salary,
    location: (data.location || employerLocation || "Kolkata").trim(),
    jobType: data.jobType || "Full-time",
    experience: data.experience || "Fresher",
    education: data.education || "Any",
    languages: langs.slice(0, 5),
    skills: skills.slice(0, 10),
  };
}

export async function rankJobsForSeeker(seeker, jobs, topN = 10) {
  if (!OPENAI_AVAILABLE || !jobs?.length) {
    return jobs.slice(0, topN).map((j) => String(j.id ?? j._id ?? ""));
  }
  const seekerSkills = [...new Set([
    ...(seeker.skills || []),
    ...((seeker.aiExtracted?.skills) || []),
  ])];
  const seekerExp = seeker.aiExtracted?.experience || seeker.experience || "Fresher";
  const seekerLoc = seeker.location || "";
  const jobsSummary = jobs.map((j) => ({
    id: String(j.id ?? j._id ?? ""),
    title: j.title || "",
    category: j.category || "",
    skills: j.skills || [],
    experience: j.experience || "",
    location: j.location || "",
  }));
  const system = `You are a job matching expert for Kolkata's local job platform. Rank jobs by how well they fit the seeker.
Consider: skill overlap, experience level match, location preference, category relevance.
Return ONLY valid JSON: {"ranked_ids": ["id1", "id2", ...]} in order of best match first.
Include ALL given job IDs exactly once.`;
  const userContent = `Seeker: skills=${JSON.stringify(seekerSkills)}, experience=${seekerExp}, location=${seekerLoc}

Jobs (rank these by fit):
${JSON.stringify(jobsSummary, null, 2)}

Return JSON with ranked_ids in best-to-worst match order:`;
  const data = await chatJson(system, userContent);
  if (!data?.ranked_ids) {
    return jobs.slice(0, topN).map((j) => String(j.id ?? j._id ?? ""));
  }
  const ranked = data.ranked_ids.filter(Boolean).map(String).slice(0, topN);
  const allIds = new Set(jobs.map((j) => String(j.id ?? j._id ?? "")));
  for (const j of jobs) {
    const jid = String(j.id ?? j._id ?? "");
    if (!ranked.includes(jid)) ranked.push(jid);
  }
  return ranked.slice(0, topN);
}

export async function rankCandidatesForJob(job, candidates, topN = 10) {
  if (!OPENAI_AVAILABLE || !candidates?.length) {
    return candidates.slice(0, topN).map((c) => String(c.id ?? c._id ?? ""));
  }
  const candSummary = candidates.map((c) => ({
    id: String(c.id ?? c._id ?? ""),
    name: c.name || "",
    skills: [...new Set([
      ...(c.skills || []),
      ...((c.aiExtracted?.skills) || []),
    ])],
    experience: c.aiExtracted?.experience || c.experience || "Fresher",
    location: c.location || "",
  }));
  const system = `You are a hiring expert for Kolkata's local job platform. Rank candidates by how well they fit the job.
Consider: skill match, experience fit, location, category relevance.
Return ONLY valid JSON: {"ranked_ids": ["id1", "id2", ...]} in order of best fit first.
Include ALL given candidate IDs exactly once.`;
  const userContent = `Job: title=${job.title || ""}, category=${job.category || ""}, skills=${JSON.stringify(job.skills || [])}, experience=${job.experience || "Fresher"}, location=${job.location || ""}

Candidates (rank these by fit):
${JSON.stringify(candSummary, null, 2)}

Return JSON with ranked_ids in best-to-worst fit order:`;
  const data = await chatJson(system, userContent);
  if (!data?.ranked_ids) {
    return candidates.slice(0, topN).map((c) => String(c.id ?? c._id ?? ""));
  }
  const ranked = data.ranked_ids.filter(Boolean).map(String).slice(0, topN);
  for (const c of candidates) {
    const cid = String(c.id ?? c._id ?? "");
    if (!ranked.includes(cid)) ranked.push(cid);
  }
  return ranked.slice(0, topN);
}
