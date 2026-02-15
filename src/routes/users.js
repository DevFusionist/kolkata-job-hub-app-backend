import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";

const router = Router();

router.post("/users", async (req, res) => {
  const body = req.body;
  const user = {
    ...body,
    freeJobsRemaining: body.role === "employer" ? 2 : 0,
    createdAt: new Date(),
  };
  const db = getDb();
  const r = await db.collection("users").insertOne(user);
  user.id = r.insertedId.toString();
  res.json(user);
});

router.get("/users/:userId", async (req, res) => {
  const db = getDb();
  const user = await db.collection("users").findOne({ _id: toObjectId(req.params.userId) });
  if (!user) return res.status(404).json({ detail: "User not found" });
  res.json(serializeDoc(user));
});

router.put("/users/:userId", async (req, res) => {
  const db = getDb();
  const r = await db.collection("users").updateOne(
    { _id: toObjectId(req.params.userId) },
    { $set: req.body }
  );
  if (r.matchedCount === 0) return res.status(404).json({ detail: "User not found" });
  const user = await db.collection("users").findOne({ _id: toObjectId(req.params.userId) });
  res.json(serializeDoc(user));
});

export default router;
