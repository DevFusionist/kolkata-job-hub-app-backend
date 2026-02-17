import { Router } from "express";
import { User } from "../models/index.js";
import { serializeDoc } from "../utils.js";
import { generateToken } from "../middleware/jwt.js";

const router = Router();

router.post("/users", async (req, res) => {
  const body = req.body;
  if (!body.phone || !/^\d{10}$/.test(body.phone)) {
    return res.status(400).json({ detail: "Invalid phone number" });
  }
  if (!body.name || body.name.trim().length < 2) {
    return res.status(400).json({ detail: "Name is required (min 2 characters)" });
  }
  if (!body.role || !["seeker", "employer"].includes(body.role)) {
    return res.status(400).json({ detail: "Role must be 'seeker' or 'employer'" });
  }
  if (body.role === "employer" && (!body.businessName || body.businessName.trim().length < 2)) {
    return res.status(400).json({ detail: "Business name required for employers" });
  }

  const existing = await User.findOne({ phone: body.phone });
  if (existing) {
    return res.status(409).json({ detail: "Phone number already registered" });
  }

  try {
    const user = await User.create({
      phone: body.phone,
      name: body.name.trim(),
      role: body.role,
      businessName: body.businessName?.trim() || null,
      location: body.location?.trim() || "",
      skills: body.skills || [],
      languages: body.languages || ["Bengali", "Hindi"],
      experience: body.experience || "Fresher",
      freeJobsRemaining: body.role === "employer" ? 2 : 0,
    });
    const serialized = serializeDoc(user);
    const token = generateToken(serialized);
    res.json({ ...serialized, token });
  } catch (err) {
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors).map(e => e.message).join(", ");
      return res.status(400).json({ detail: msg });
    }
    throw err;
  }
});

router.get("/users/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).lean();
    if (!user) return res.status(404).json({ detail: "User not found" });
    res.json(serializeDoc(user));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid user ID" });
    throw e;
  }
});

router.put("/users/:userId", async (req, res) => {
  try {
    const { mpinHash, role, phone, _id, id, __v, ...safeFields } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { $set: safeFields },
      { new: true, runValidators: true }
    ).lean();
    if (!user) return res.status(404).json({ detail: "User not found" });
    res.json(serializeDoc(user));
  } catch (e) {
    if (e.name === "CastError") return res.status(400).json({ detail: "Invalid user ID" });
    if (e.name === "ValidationError") {
      const msg = Object.values(e.errors).map(v => v.message).join(", ");
      return res.status(400).json({ detail: msg });
    }
    throw e;
  }
});

export default router;
