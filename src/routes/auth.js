import { Router } from "express";
import { User } from "../models/index.js";
import { hashMpin, serializeDoc } from "../utils.js";
import { generateToken } from "../middleware/jwt.js";
import { sendOtp as twilioSendOtp, verifyOtp as twilioVerifyOtp } from "../lib/twilio.js";

const router = Router();

function toE164(phone) {
  const digits = String(phone).replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `+91${digits}` : null;
}

router.post("/auth/send-otp", async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  }
  const e164 = toE164(phone);
  const result = await twilioSendOtp(e164);
  if (!result.success) {
    return res
      .status(502)
      .json({ success: false, message: result.message || "Failed to send OTP" });
  }
  res.json({ success: true, message: "OTP sent to your number." });
});

router.post("/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  }
  if (!otp || otp.length !== 6) {
    return res.status(400).json({ success: false, message: "Invalid OTP" });
  }
  const e164 = toE164(phone);
  const result = await twilioVerifyOtp(e164, otp);
  if (!result.success) {
    return res.status(401).json({ success: false, message: result.message || "Incorrect or expired OTP" });
  }
  const user = await User.findOne({ phone }).lean();
  if (user) {
    const serialized = serializeDoc(user);
    const token = generateToken(serialized);
    return res.json({ success: true, user: serialized, token, isNewUser: false });
  }
  res.json({ success: true, isNewUser: true, phone });
});

router.post("/auth/login", async (req, res) => {
  const { phone, mpin } = req.body;
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ detail: "Invalid phone number" });
  }
  if (!mpin || mpin.length < 4 || mpin.length > 6) {
    return res.status(400).json({ detail: "MPIN must be 4-6 digits" });
  }
  const user = await User.findOne({ phone }).lean();
  if (!user) {
    return res.status(404).json({ detail: "User not found. Please register first." });
  }
  if (!user.mpinHash) {
    return res.status(400).json({ detail: "MPIN not set. Complete registration first." });
  }
  if (hashMpin(mpin) !== user.mpinHash) {
    return res.status(401).json({ detail: "Invalid MPIN" });
  }
  const serialized = serializeDoc(user);
  const token = generateToken(serialized);
  res.json({ success: true, user: serialized, token });
});

router.post("/auth/set-mpin", async (req, res) => {
  const { phone, mpin } = req.body;
  if (!mpin || mpin.length < 4 || mpin.length > 6) {
    return res.status(400).json({ detail: "MPIN must be 4-6 digits" });
  }
  const user = await User.findOne({ phone });
  if (!user) {
    return res.status(404).json({ detail: "User not found" });
  }
  user.mpinHash = hashMpin(mpin);
  await user.save();
  res.json({ success: true, message: "MPIN set successfully" });
});

export default router;
