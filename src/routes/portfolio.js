import { Router } from "express";
import multer from "multer";
import { Portfolio, User } from "../models/index.js";
import { serializeDoc } from "../utils.js";
import { requireSeeker } from "../middleware/auth.js";
import { invalidateUserCache } from "../middleware/jwt.js";
import { analyzePortfolio } from "../services/ai.js";
import { uploadFile, getPresignedUrl, r2Configured } from "../lib/r2.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  buildResumeData,
  generateResumeWithAI,
  renderResumePDF,
  uploadResumePDF,
} from "../services/resumeBuilder.js";
import logger from "../lib/logger.js";

const router = Router();
const MAX_OVERRIDE_TEXT = 500;
const MAX_OVERRIDE_ARRAY = 30;

// Multer config: memory storage, 5MB limit, PDF/DOC/DOCX only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOC, and DOCX files are allowed"));
    }
  },
});

router.get("/portfolios/seeker/:seekerId", requireSeeker, async (req, res) => {
  if (req.params.seekerId !== req.seekerId) {
    return res.status(403).json({ detail: "You can only view your own portfolio" });
  }
  try {
    const portfolio = await Portfolio.findOne({ seeker: req.params.seekerId })
      .sort({ createdAt: -1 })
      .lean();
    if (!portfolio) return res.json(null);
    res.json(serializeDoc(portfolio));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid seeker ID" });
    throw e;
  }
});

/**
 * Get viewable URLs for the current seeker's resumes (public URL or presigned if private).
 */
router.get(
  "/portfolios/resume-view-url",
  requireSeeker,
  asyncHandler(async (req, res) => {
    const portfolio = await Portfolio.findOne({ seeker: req.seekerId })
      .sort({ createdAt: -1 })
      .lean();
    if (!portfolio) {
      return res.json({ uploadUrl: null, generatedUrl: null });
    }

    const toViewUrl = async (stored) => {
      if (!stored || typeof stored !== "string") return null;
      if (stored.startsWith("http://") || stored.startsWith("https://")) return stored;
      if (!r2Configured) return null;
      try {
        return await getPresignedUrl(stored);
      } catch (e) {
        logger.warn({ err: e.message, key: stored }, "Failed to get presigned resume URL");
        return null;
      }
    };

    const [uploadUrl, generatedUrl] = await Promise.all([
      toViewUrl(portfolio.resumeUrl),
      toViewUrl(portfolio.generatedResumeUrl),
    ]);
    res.json({ uploadUrl, generatedUrl });
  })
);

/**
 * Upload a resume file (PDF/DOC/DOCX).
 * 1. Uploads to R2 storage
 * 2. Extracts text from PDF using pdf-parse
 * 3. Runs AI portfolio analysis on extracted text
 * 4. Updates Portfolio and User records
 */
router.post(
  "/portfolios/upload-resume",
  requireSeeker,
  upload.single("resume"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ detail: "No file uploaded" });
    }

    const seekerId = req.seekerId;
    const file = req.file;
    const timestamp = Date.now();
    const ext = file.originalname.split(".").pop() || "pdf";
    const r2Key = `resumes/${seekerId}/${timestamp}.${ext}`;

    // 1. Upload to R2 (if configured)
    let resumeUrl = null;
    if (r2Configured) {
      try {
        resumeUrl = await uploadFile(r2Key, file.buffer, file.mimetype);
        logger.info({ seekerId, key: r2Key }, "Resume uploaded to R2");
      } catch (e) {
        logger.error({ err: e, seekerId }, "R2 upload failed");
        return res.status(500).json({ detail: "File upload failed. Please try again." });
      }
    } else {
      logger.warn("R2 not configured, skipping file storage");
    }

    // 2. Extract text from PDF
    let extractedText = "";
    if (file.mimetype === "application/pdf") {
      try {
        const pdfParse = (await import("pdf-parse")).default;
        const pdfData = await pdfParse(file.buffer);
        extractedText = pdfData.text || "";
      } catch (e) {
        logger.warn({ err: e.message }, "PDF text extraction failed");
      }
    }

    // 3. Run AI analysis on extracted text (consumes AI credits)
    let aiResult = null;
    if (extractedText.trim().length > 10) {
      try {
        aiResult = await analyzePortfolio(extractedText, [], [], { userId: seekerId });
        if (aiResult?.paymentRequired) {
          // Upload and rawText are saved below; return 402 so client can show payment modal
          const portfolioUpdate = {
            resumeUrl: resumeUrl ?? null,
            resumeFileName: file.originalname,
            rawText: extractedText.slice(0, 10000),
          };
          let portfolio = await Portfolio.findOne({ seeker: seekerId }).sort({ createdAt: -1 });
          if (portfolio) {
            Object.assign(portfolio, portfolioUpdate);
            await portfolio.save();
          } else {
            portfolio = await Portfolio.create({ seeker: seekerId, ...portfolioUpdate });
          }
          return res.status(402).json({
            detail: "AI credits exhausted. Resume uploaded. Buy credits to analyze it.",
            action: "payment_required",
            saved: true,
            resumeUrl,
            fileName: file.originalname,
          });
        }
      } catch (e) {
        logger.warn({ err: e.message }, "AI portfolio analysis failed during upload");
      }
    }

    // 4. Upsert Portfolio document
    const portfolioUpdate = {
      resumeUrl,
      resumeFileName: file.originalname,
    };
    if (extractedText) {
      portfolioUpdate.rawText = extractedText.slice(0, 10000);
    }

    let portfolio = await Portfolio.findOne({ seeker: seekerId }).sort({ createdAt: -1 });
    if (portfolio) {
      Object.assign(portfolio, portfolioUpdate);
      await portfolio.save();
    } else {
      portfolio = await Portfolio.create({
        seeker: seekerId,
        ...portfolioUpdate,
      });
    }

    // 5. Update user with AI-extracted skills (normalize to strings)
    let mergedSkills = null;
    if (aiResult?.skills?.length) {
      const dbUser = await User.findById(seekerId);
      if (dbUser) {
        const existing = (dbUser.skills || []).map((s) => (typeof s === "string" ? s.trim() : String(s).trim())).filter(Boolean);
        const existingSkills = new Set(existing);
        for (const s of aiResult.skills) {
          const skill = typeof s === "string" ? s.trim() : String(s ?? "").trim();
          if (skill && !existingSkills.has(skill)) existingSkills.add(skill);
        }
        mergedSkills = [...existingSkills].slice(0, 30);
        dbUser.skills = mergedSkills;
        const existingAi = dbUser.aiExtracted || {};
        const existingAiSkills = (existingAi.skills || []).map((s) => (typeof s === "string" ? String(s).trim() : String(s).trim())).filter(Boolean);
        const aiSkillsSet = new Set(existingAiSkills);
        for (const s of aiResult.skills) {
          const skill = typeof s === "string" ? s.trim() : String(s ?? "").trim();
          if (skill) aiSkillsSet.add(skill);
        }
        dbUser.aiExtracted = {
          skills: [...aiSkillsSet].slice(0, 30),
          experience: aiResult.experience || existingAi.experience || "",
          category: aiResult.category || existingAi.category || "",
          score: typeof aiResult.score === "number" ? aiResult.score : (existingAi.score ?? 0),
        };
        await dbUser.save();
        invalidateUserCache(seekerId);
      }
    }

    res.json({
      success: true,
      resumeUrl,
      fileName: file.originalname,
      extractedText: extractedText ? extractedText.slice(0, 500) + (extractedText.length > 500 ? "..." : "") : null,
      aiAnalysis: aiResult || null,
      mergedSkills: mergedSkills ?? undefined,
      portfolio: portfolio.toJSON(),
    });
  })
);

/**
 * Build an AI-generated ATS resume.
 * 1. Gathers user data
 * 2. AI generates structured resume JSON
 * 3. Renders to PDF via Puppeteer
 * 4. Uploads to R2
 * 5. Returns URL + preview data
 */
router.post(
  "/portfolios/build-resume",
  requireSeeker,
  asyncHandler(async (req, res) => {
    const seekerId = req.seekerId;

    // Allow user to provide overrides for resume data
    const overrides = req.body && typeof req.body === "object" ? req.body : {};

    logger.info({ seekerId }, "Building AI resume");

    // 1. Build resume data from user profile
    const resumeData = await buildResumeData(seekerId);

    // Apply user overrides (from the builder form)
    if (overrides.name) resumeData.name = String(overrides.name).slice(0, MAX_OVERRIDE_TEXT);
    if (overrides.phone) resumeData.phone = String(overrides.phone).slice(0, 20);
    if (overrides.location) resumeData.location = String(overrides.location).slice(0, MAX_OVERRIDE_TEXT);
    if (Array.isArray(overrides.skills) && overrides.skills.length) {
      resumeData.skills = overrides.skills.slice(0, MAX_OVERRIDE_ARRAY).map((s) => String(s || "").slice(0, 60));
    }
    if (overrides.experience) resumeData.experience = String(overrides.experience).slice(0, 40);
    if (Array.isArray(overrides.languages) && overrides.languages.length) {
      resumeData.languages = overrides.languages.slice(0, MAX_OVERRIDE_ARRAY).map((l) => String(l || "").slice(0, 40));
    }
    if (overrides.portfolioText) resumeData.portfolioText = String(overrides.portfolioText).slice(0, 4000);

    // 2. Generate resume with AI (consumes AI credits)
    const resumeResult = await generateResumeWithAI(resumeData, { userId: seekerId });
    if (resumeResult && typeof resumeResult === "object" && resumeResult.paymentRequired) {
      return res.status(402).json({
        detail: "AI credits exhausted. Buy credits to generate an AI resume.",
        action: "payment_required",
      });
    }
    const resumeJson = resumeResult;

    // 3. Render to PDF
    const { html, pdf } = await renderResumePDF(resumeJson);

    // 4. Upload PDF to R2 if available
    let generatedResumeUrl = null;
    if (pdf && r2Configured) {
      try {
        generatedResumeUrl = await uploadResumePDF(seekerId, pdf);
        logger.info({ seekerId, url: generatedResumeUrl }, "AI resume uploaded to R2");
      } catch (e) {
        logger.error({ err: e.message }, "Failed to upload AI resume to R2");
      }
    }

    // 5. Update Portfolio with generated resume URL
    if (generatedResumeUrl) {
      let portfolio = await Portfolio.findOne({ seeker: seekerId }).sort({ createdAt: -1 });
      if (portfolio) {
        portfolio.generatedResumeUrl = generatedResumeUrl;
        await portfolio.save();
      } else {
        await Portfolio.create({ seeker: seekerId, generatedResumeUrl });
      }
    }

    res.json({
      success: true,
      resume: resumeJson,
      html,
      generatedResumeUrl,
      hasPdf: !!pdf,
    });
  })
);

export default router;
