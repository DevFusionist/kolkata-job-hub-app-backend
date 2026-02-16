import { Router } from "express";
import { getDb } from "../config/db.js";
import { hashMpin, serializeDoc } from "../utils.js";
import { ObjectId } from "mongodb";
import { generateToken } from "../middleware/jwt.js";

const router = Router();

router.post("/auth/send-otp", (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ success: false, message: "Invalid phone number" });
  }
  res.json({ success: true, message: "OTP sent. Use 123456 for testing." });
});

router.post("/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!otp || otp.length !== 6) {
    return res.status(400).json({ success: false, message: "Invalid OTP" });
  }
  if (otp !== "123456") {
    return res.status(401).json({ success: false, message: "Incorrect OTP" });
  }
  const db = getDb();
  const user = await db.collection("users").findOne({ phone });
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
  const db = getDb();
  const user = await db.collection("users").findOne({ phone });
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
  const db = getDb();
  const user = await db.collection("users").findOne({ phone });
  if (!user) {
    return res.status(404).json({ detail: "User not found" });
  }
  await db.collection("users").updateOne(
    { phone },
    { $set: { mpinHash: hashMpin(mpin) } }
  );
  res.json({ success: true, message: "MPIN set successfully" });
});

export default router;
