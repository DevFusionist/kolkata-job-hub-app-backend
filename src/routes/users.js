import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { generateToken } from "../middleware/jwt.js";

const router = Router();

router.post("/users", async (req, res) => {
  const body = req.body;
  // Basic validation
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

  const db = getDb();
  // Check for duplicate phone
  const existing = await db.collection("users").findOne({ phone: body.phone });
  if (existing) {
    return res.status(409).json({ detail: "Phone number already registered" });
  }

  const user = {
    ...body,
    freeJobsRemaining: body.role === "employer" ? 2 : 0,
    createdAt: new Date(),
  };
  const r = await db.collection("users").insertOne(user);
  const serialized = serializeDoc({ ...user, _id: r.insertedId });
  const token = generateToken(serialized);
  res.json({ ...serialized, token });
});

router.get("/users/:userId", async (req, res) => {
  const db = getDb();
  try {
    const user = await db.collection("users").findOne({ _id: toObjectId(req.params.userId) });
    if (!user) return res.status(404).json({ detail: "User not found" });
    res.json(serializeDoc(user));
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid user ID" });
    throw e;
  }
});

router.put("/users/:userId", async (req, res) => {
  const db = getDb();
  try {
    // Prevent updating sensitive fields via this endpoint
    const { mpinHash, role, phone, _id, id, ...safeFields } = req.body;
    const r = await db.collection("users").updateOne(
      { _id: toObjectId(req.params.userId) },
      { $set: safeFields }
    );
    if (r.matchedCount === 0) return res.status(404).json({ detail: "User not found" });
    const user = await db.collection("users").findOne({ _id: toObjectId(req.params.userId) });
    res.json(serializeDoc(user));
  } catch (e) {
    if (e.name === "TypeError") return res.status(400).json({ detail: "Invalid user ID" });
    throw e;
  }
});

export default router;
