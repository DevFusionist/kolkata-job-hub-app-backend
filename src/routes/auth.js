import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { User } from "../models/index.js";
import { hashMpin, serializeDoc } from "../utils.js";
import {
  generateToken,
  generateRegistrationToken,
  generateMpinResetToken,
  verifyMpinResetToken,
  invalidateUserCache,
} from "../middleware/jwt.js";
import { sendOtp as twilioSendOtp, verifyOtp as twilioVerifyOtp } from "../lib/twilio.js";

const router = Router();
const OTP_PURPOSES = new Set(["register", "reset_mpin"]);
const OTP_WINDOW_MS = 10 * 60 * 1000;
const MPIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
const MPIN_MAX_FAILURES = 6;
const mpinFailures = new Map(); // phone -> { count, lockUntil }

function toE164(phone) {
  const digits = String(phone).replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `+91${digits}` : null;
}

function parseOtpPurpose(raw) {
  const purpose = String(raw || "").trim().toLowerCase();
  return OTP_PURPOSES.has(purpose) ? purpose : null;
}

function phoneAwareKey(req) {
  const phone = String(req.body?.phone || "").replace(/\D/g, "").slice(-10) || "unknown";
  return `${ipKeyGenerator(req.ip)}:${phone}`;
}

const rateLimitValidate = { validate: { xForwardedForHeader: false } };

const sendOtpLimiter = rateLimit({
  windowMs: OTP_WINDOW_MS,
  max: 3,
  keyGenerator: phoneAwareKey,
  message: { detail: "Too many OTP requests. Please try again later." },
  ...rateLimitValidate,
});

const verifyOtpLimiter = rateLimit({
  windowMs: OTP_WINDOW_MS,
  max: 8,
  keyGenerator: phoneAwareKey,
  message: { detail: "Too many OTP verification attempts. Please try again later." },
  ...rateLimitValidate,
});

const loginLimiter = rateLimit({
  windowMs: OTP_WINDOW_MS,
  max: 20,
  keyGenerator: phoneAwareKey,
  message: { detail: "Too many login attempts. Please try again later." },
  ...rateLimitValidate,
});

const setMpinLimiter = rateLimit({
  windowMs: OTP_WINDOW_MS,
  max: 8,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.userId || req.headers["x-mpin-reset-token"] || "unknown")}`,
  message: { detail: "Too many MPIN reset attempts. Please try again later." },
  ...rateLimitValidate,
});

function getMpinFailure(phone) {
  const key = String(phone || "");
  const now = Date.now();
  const entry = mpinFailures.get(key);
  if (!entry) return null;
  if (entry.lockUntil && now > entry.lockUntil) {
    mpinFailures.delete(key);
    return null;
  }
  return entry;
}

function markMpinFailure(phone) {
  const key = String(phone || "");
  const now = Date.now();
  const current = getMpinFailure(key) || { count: 0, lockUntil: 0 };
  const nextCount = current.count + 1;
  const lockUntil = nextCount >= MPIN_MAX_FAILURES ? now + MPIN_LOCK_WINDOW_MS : 0;
  mpinFailures.set(key, { count: nextCount, lockUntil });
}

function clearMpinFailures(phone) {
  mpinFailures.delete(String(phone || ""));
}

router.post("/auth/send-otp", sendOtpLimiter, async (req, res) => {
  const { phone, purpose: rawPurpose } = req.body;
  const purpose = parseOtpPurpose(rawPurpose);

  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  }
  if (!purpose) {
    return res.status(400).json({ success: false, message: "Invalid OTP purpose" });
  }

  const existingUser = await User.findOne({ phone }).select("_id").lean();
  if (purpose === "register" && existingUser) {
    return res.status(409).json({
      success: false,
      detail: "This phone is already registered. Please login with MPIN.",
    });
  }
  if (purpose === "reset_mpin" && !existingUser) {
    return res.status(404).json({
      success: false,
      detail: "User not found. Please register first.",
    });
  }

  // const e164 = toE164(phone);
  // const result = await twilioSendOtp(e164);
  // if (!result.success) {
  //   return res
  //     .status(502)
  //     .json({ success: false, message: result.message || "Failed to send OTP" });
  // }
  res.json({ success: true, message: "OTP sent to your number.", purpose });
});

router.post("/auth/verify-otp", verifyOtpLimiter, async (req, res) => {
  const { phone, otp, purpose: rawPurpose } = req.body;
  const purpose = parseOtpPurpose(rawPurpose);

  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  }
  if (!/^\d{6}$/.test(String(otp || ""))) {
    return res.status(400).json({ success: false, message: "Invalid OTP" });
  }
  if (!purpose) {
    return res.status(400).json({ success: false, message: "Invalid OTP purpose" });
  }

  // const e164 = toE164(phone);
  // const result = await twilioVerifyOtp(e164, otp);
  // if (!result.success) {
  //   return res.status(401).json({ success: false, message: result.message || "Incorrect or expired OTP" });
  // }
  const user = await User.findOne({ phone }).lean();
  if (purpose === "register") {
    if (user) {
      return res.status(409).json({
        success: false,
        detail: "This phone is already registered. Please login with MPIN.",
      });
    }
    const registrationToken = generateRegistrationToken(phone);
    return res.json({ success: true, isNewUser: true, phone, registrationToken });
  }

  if (!user) {
    return res.status(404).json({ success: false, detail: "User not found. Please register first." });
  }

  if (purpose === "reset_mpin") {
    const mpinResetToken = generateMpinResetToken(user);
    return res.json({
      success: true,
      isNewUser: false,
      purpose,
      phone,
      mpinResetToken,
      user: {
        id: user._id.toString(),
        name: user.name,
        role: user.role,
      },
    });
  }

  return res.status(400).json({ success: false, detail: "Invalid OTP purpose" });
});

router.post("/auth/login", loginLimiter, async (req, res) => {
  const { phone, mpin } = req.body;
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ detail: "Invalid phone number" });
  }
  if (!/^\d{4,6}$/.test(String(mpin || ""))) {
    return res.status(400).json({ detail: "MPIN must be 4-6 digits" });
  }
  const failure = getMpinFailure(phone);
  if (failure?.lockUntil && failure.lockUntil > Date.now()) {
    const waitSec = Math.ceil((failure.lockUntil - Date.now()) / 1000);
    return res.status(429).json({ detail: `Too many invalid attempts. Try again in ${waitSec}s` });
  }

  const user = await User.findOne({ phone }).lean();
  if (!user || !user.mpinHash || hashMpin(mpin) !== user.mpinHash) {
    markMpinFailure(phone);
    return res.status(401).json({ detail: "Invalid credentials" });
  }
  clearMpinFailures(phone);
  const serialized = serializeDoc(user);
  const token = generateToken(serialized);
  res.json({ success: true, user: serialized, token });
});

router.post("/auth/set-mpin", setMpinLimiter, async (req, res) => {
  const { mpin } = req.body;
  if (!/^\d{4,6}$/.test(String(mpin || ""))) {
    return res.status(400).json({ detail: "MPIN must be 4-6 digits" });
  }

  let targetUserId = req.userId || null;
  let resetPhone = null;

  const resetToken = req.headers["x-mpin-reset-token"];
  if (resetToken) {
    try {
      const decoded = verifyMpinResetToken(resetToken);
      targetUserId = decoded.userId;
      resetPhone = decoded.phone;
    } catch {
      return res.status(401).json({ detail: "Invalid or expired MPIN reset token" });
    }
  }

  if (!targetUserId) {
    return res.status(401).json({ detail: "Authentication required" });
  }

  const user = await User.findById(targetUserId);
  if (!user) {
    return res.status(404).json({ detail: "User not found" });
  }
  if (resetPhone && user.phone !== resetPhone) {
    return res.status(401).json({ detail: "MPIN reset token does not match this user" });
  }
  user.mpinHash = hashMpin(mpin);
  await user.save();
  invalidateUserCache(targetUserId);
  clearMpinFailures(user.phone);
  res.json({ success: true, message: "MPIN set successfully" });
});

export default router;
