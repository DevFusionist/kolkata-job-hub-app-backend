import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { requireSeeker } from "../middleware/auth.js";

const router = Router();

router.get("/portfolios/seeker/:seekerId", async (req, res) => {
  const db = getDb();
  const portfolio = await db.collection("portfolios").findOne(
    { seekerId: req.params.seekerId },
    { sort: { createdAt: -1 } }
  );
  if (!portfolio) return res.json(null);
  res.json(serializeDoc(portfolio));
});

router.post("/portfolios", requireSeeker, async (req, res) => {
  const seekerId = req.seekerId;
  const { rawText = "", projects = [], links = [] } = req.body;
  const db = getDb();
  const doc = {
    seekerId,
    rawText,
    projects,
    links,
    createdAt: new Date(),
  };
  const r = await db.collection("portfolios").insertOne(doc);
  doc.id = r.insertedId.toString();
  res.json(serializeDoc(doc));
});

export default router;
