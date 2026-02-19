/**
 * AI Resume Builder Service
 *
 * - Fetches user profile, portfolio, skills, experience, applications
 * - Uses OpenAI to generate an ATS-optimized resume in structured JSON
 * - Renders the JSON into clean HTML and converts to PDF using Puppeteer
 * - Uploads the PDF to R2 storage
 */

import OpenAI from "openai";
import { User, Portfolio, Application, Job } from "../models/index.js";
import { uploadFile } from "../lib/r2.js";
import { clampAiOutputTokens, enforceAiBudget, truncateAiInput } from "../lib/aiBudget.js";
import { reserveAiCredits, rollbackAiCredits } from "../lib/aiCredits.js";
import logger from "../lib/logger.js";

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

/**
 * Step 1: Build resume data object from user's profile and history.
 */
export async function buildResumeData(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw new Error("User not found");

  const portfolio = await Portfolio.findOne({ seeker: userId })
    .sort({ createdAt: -1 })
    .lean();

  const applications = await Application.find({ seeker: userId })
    .sort({ appliedDate: -1 })
    .limit(20)
    .populate("job", "title category location salary skills")
    .lean();

  const allSkills = [
    ...new Set([
      ...(user.skills || []),
      ...(user.aiExtracted?.skills || []),
    ]),
  ];

  const appliedJobTitles = applications
    .map((a) => a.job?.title)
    .filter(Boolean)
    .slice(0, 5);
  const appliedJobSkills = [
    ...new Set(applications.flatMap((a) => a.job?.skills || [])),
  ].slice(0, 15);

  return {
    name: user.name || "",
    phone: user.phone || "",
    location: user.location || "Kolkata",
    languages: user.languages || ["Bengali", "Hindi", "English"],
    skills: allSkills,
    experience: user.aiExtracted?.experience || user.experience || "Fresher",
    category: user.aiExtracted?.category || "",
    portfolioText: portfolio?.rawText?.slice(0, 3000) || "",
    appliedJobTitles,
    appliedJobSkills,
    role: "seeker",
  };
}

/**
 * Step 2: Generate resume content using AI (structured JSON output).
 */
export async function generateResumeWithAI(resumeData, opts = {}) {
  const client = getClient();

  const systemPrompt = `You are a professional resume writer specializing in ATS-optimized resumes for the Indian job market (Kolkata area).

Generate a professional resume in JSON format following these ATS best practices:
- Use STANDARD section headers: "Summary", "Skills", "Experience", "Education", "Languages"
- Reverse chronological order for experience
- Quantify achievements where possible (numbers, percentages)
- Include industry keywords from the user's skills and applied jobs
- NO graphics, tables, or multi-column layouts (ATS parsers can't read them)
- Clean formatting with consistent structure
- Contact info at the top
- Skills section with keyword density optimization
- Keep it concise: 1 page equivalent

Return ONLY valid JSON:
{
  "contact": { "name": "", "phone": "", "location": "", "email": "" },
  "summary": "2-3 sentence professional summary",
  "skills": ["skill1", "skill2", ...],
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "duration": "Duration",
      "achievements": ["Achievement 1", "Achievement 2"]
    }
  ],
  "education": [
    { "degree": "", "institution": "", "year": "" }
  ],
  "languages": ["Language 1", "Language 2"],
  "certifications": ["cert1"]
}

If the user has limited experience, create a compelling entry-level resume that highlights transferable skills, eagerness to learn, and relevant abilities. For "Fresher", create a functional resume focusing on skills.`;

  const userPrompt = `Build an ATS-optimized resume for:
Name: ${resumeData.name}
Phone: ${resumeData.phone}
Location: ${resumeData.location}
Skills: ${resumeData.skills.join(", ")}
Experience Level: ${resumeData.experience}
Category/Field: ${resumeData.category || "General"}
Languages: ${resumeData.languages.join(", ")}
Portfolio/Background: ${resumeData.portfolioText || "Not provided"}
Applied to jobs like: ${resumeData.appliedJobTitles.join(", ") || "None yet"}
Industry keywords to include: ${resumeData.appliedJobSkills.join(", ") || "General skills"}

Generate a professional, ATS-friendly resume JSON:`;

  if (!client) {
    return buildFallbackResume(resumeData);
  }

  const maxTokens = clampAiOutputTokens(420, 420);
  const promptText = truncateAiInput(`${systemPrompt}\n\n${userPrompt}`);
  const budget = enforceAiBudget({ userId: opts.userId, promptText, maxOutputTokens: maxTokens });
  if (!budget.ok) {
    logger.warn({ userId: opts.userId, reason: budget.reason }, "AI resume budget exceeded, using fallback");
    return buildFallbackResume(resumeData);
  }

  // Reserve AI credits before calling OpenAI
  const estimatedTokens = Math.ceil((promptText.length || 0) / 4) + maxTokens;
  let reservation = null;
  if (opts.userId) {
    reservation = await reserveAiCredits(opts.userId, Math.min(estimatedTokens, 1200));
    if (!reservation.ok) {
      return { paymentRequired: true };
    }
  }

  try {
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: truncateAiInput(systemPrompt) },
        { role: "user", content: truncateAiInput(userPrompt) },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    });

    const raw = (response.choices[0]?.message?.content || "").trim();
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""));
    return parsed;
  } catch (e) {
    if (reservation?.ok && opts.userId) {
      await rollbackAiCredits(opts.userId, reservation.source, reservation.tokensReserved);
    }
    logger.error({ err: e.message }, "AI resume generation failed, using fallback");
    return buildFallbackResume(resumeData);
  }
}

function buildFallbackResume(data) {
  return {
    contact: {
      name: data.name,
      phone: data.phone,
      location: data.location,
      email: "",
    },
    summary: `Motivated ${data.experience} professional based in ${data.location} with skills in ${data.skills.slice(0, 5).join(", ")}. Seeking opportunities in ${data.category || "various fields"}.`,
    skills: data.skills.slice(0, 15),
    experience: [
      {
        title: data.category || "Professional",
        company: "Self-employed / Freelance",
        duration: data.experience === "Fresher" ? "Looking for first role" : data.experience,
        achievements: [
          `Proficient in ${data.skills.slice(0, 3).join(", ")}`,
          `Based in ${data.location} with knowledge of local area`,
        ],
      },
    ],
    education: [{ degree: "As per qualification", institution: "", year: "" }],
    languages: data.languages,
    certifications: [],
  };
}

/**
 * Step 3: Render resume JSON into HTML and convert to PDF using Puppeteer.
 */
export async function renderResumePDF(resumeJson) {
  const html = generateResumeHTML(resumeJson);

  let puppeteer;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    logger.warn("Puppeteer not available, returning HTML only");
    return { html, pdf: null };
  }

  let browser;
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0.5in", right: "0.5in", bottom: "0.5in", left: "0.5in" },
    });
    return { html, pdf: Buffer.from(pdfBuffer) };
  } catch (e) {
    logger.error({ err: e.message }, "PDF generation failed");
    return { html, pdf: null };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function generateResumeHTML(resume) {
  const contact = resume.contact || {};
  const skills = resume.skills || [];
  const experience = resume.experience || [];
  const education = resume.education || [];
  const languages = resume.languages || [];
  const certifications = resume.certifications || [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #333;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
  }
  h1 { font-size: 22pt; color: #1a1a1a; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
  h2 { font-size: 13pt; color: #2c5282; border-bottom: 2px solid #2c5282; padding-bottom: 4px; margin: 16px 0 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .contact-info { color: #555; font-size: 10pt; margin-bottom: 12px; }
  .contact-info span { margin-right: 12px; }
  .summary { margin-bottom: 8px; font-style: italic; color: #444; }
  .skills-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .skill-tag { background: #e2e8f0; padding: 2px 10px; border-radius: 3px; font-size: 10pt; }
  .exp-entry { margin-bottom: 12px; }
  .exp-header { display: flex; justify-content: space-between; align-items: baseline; }
  .exp-title { font-weight: bold; font-size: 11pt; }
  .exp-company { color: #555; font-size: 10pt; }
  .exp-duration { color: #777; font-size: 9pt; }
  .exp-achievements { margin-top: 4px; padding-left: 18px; }
  .exp-achievements li { margin-bottom: 3px; font-size: 10.5pt; }
  .edu-entry { margin-bottom: 6px; }
  .edu-degree { font-weight: bold; }
  .languages-list { font-size: 10.5pt; }
  .cert-list { font-size: 10.5pt; }
</style>
</head>
<body>
  <h1>${escapeHtml(contact.name || "")}</h1>
  <div class="contact-info">
    ${contact.phone ? `<span>📞 ${escapeHtml(contact.phone)}</span>` : ""}
    ${contact.location ? `<span>📍 ${escapeHtml(contact.location)}</span>` : ""}
    ${contact.email ? `<span>✉ ${escapeHtml(contact.email)}</span>` : ""}
  </div>

  ${resume.summary ? `<h2>Professional Summary</h2><p class="summary">${escapeHtml(resume.summary)}</p>` : ""}

  ${skills.length ? `
  <h2>Skills</h2>
  <div class="skills-list">
    ${skills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("")}
  </div>` : ""}

  ${experience.length ? `
  <h2>Experience</h2>
  ${experience.map(exp => `
  <div class="exp-entry">
    <div class="exp-header">
      <div>
        <span class="exp-title">${escapeHtml(exp.title || "")}</span>
        ${exp.company ? `<span class="exp-company"> — ${escapeHtml(exp.company)}</span>` : ""}
      </div>
      ${exp.duration ? `<span class="exp-duration">${escapeHtml(exp.duration)}</span>` : ""}
    </div>
    ${exp.achievements?.length ? `
    <ul class="exp-achievements">
      ${exp.achievements.map(a => `<li>${escapeHtml(a)}</li>`).join("")}
    </ul>` : ""}
  </div>`).join("")}` : ""}

  ${education.length ? `
  <h2>Education</h2>
  ${education.map(edu => `
  <div class="edu-entry">
    <span class="edu-degree">${escapeHtml(edu.degree || "")}</span>
    ${edu.institution ? ` — ${escapeHtml(edu.institution)}` : ""}
    ${edu.year ? ` (${escapeHtml(edu.year)})` : ""}
  </div>`).join("")}` : ""}

  ${languages.length ? `
  <h2>Languages</h2>
  <p class="languages-list">${languages.map(escapeHtml).join(", ")}</p>` : ""}

  ${certifications.length ? `
  <h2>Certifications</h2>
  <p class="cert-list">${certifications.map(escapeHtml).join(", ")}</p>` : ""}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Step 4: Upload generated PDF to R2.
 */
export async function uploadResumePDF(userId, pdfBuffer) {
  const key = `resumes/${userId}/generated_${Date.now()}.pdf`;
  const url = await uploadFile(key, pdfBuffer, "application/pdf");
  return url;
}
