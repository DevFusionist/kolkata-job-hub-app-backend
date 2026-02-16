import { Router } from "express";
import { getDb } from "../config/db.js";
import { serializeDoc, toObjectId } from "../utils.js";
import { requireUser } from "../middleware/auth.js";

const router = Router();
let wsSendMessage = () => {};

export function setWsSendMessage(fn) {
  wsSendMessage = fn;
}

router.post("/messages", requireUser, async (req, res) => {
  const senderId = req.userId;
  const { receiverId, jobId, message } = req.body;

  if (!receiverId) {
    return res.status(400).json({ detail: "receiverId is required" });
  }
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ detail: "Message cannot be empty" });
  }
  if (message.length > 1000) {
    return res.status(400).json({ detail: "Message too long (max 1000 characters)" });
  }
  if (receiverId === senderId) {
    return res.status(400).json({ detail: "Cannot send message to yourself" });
  }

  // Verify receiver exists
  const db = getDb();
  try {
    const receiver = await db.collection("users").findOne({ _id: toObjectId(receiverId) });
    if (!receiver) return res.status(404).json({ detail: "Receiver not found" });
  } catch {
    return res.status(400).json({ detail: "Invalid receiverId" });
  }

  const msg = {
    receiverId,
    jobId: jobId || "",
    message: message.trim(),
    senderId,
    timestamp: new Date(),
    read: false,
  };
  const r = await db.collection("messages").insertOne(msg);
  msg.id = r.insertedId.toString();
  const msgForWs = {
    id: msg.id,
    senderId,
    receiverId,
    message: msg.message,
    jobId: msg.jobId,
    timestamp: msg.timestamp.toISOString(),
    read: false,
  };
  wsSendMessage(receiverId, { type: "new_message", payload: msgForWs });
  res.json({ ...msg, timestamp: msgForWs.timestamp });
});

router.get("/messages/:userId", async (req, res) => {
  const otherUserId = req.query.other_user_id;
  if (!otherUserId) {
    return res.status(400).json({ detail: "other_user_id query param required" });
  }
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const skip = (page - 1) * limit;

  const messages = await db.collection("messages")
    .find({
      $or: [
        { senderId: req.params.userId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: req.params.userId },
      ],
    })
    .sort({ timestamp: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  res.json(messages.map(serializeDoc));
});

router.get("/messages/conversations/:userId", async (req, res) => {
  const db = getDb();
  const pipeline = [
    { $match: { $or: [{ senderId: req.params.userId }, { receiverId: req.params.userId }] } },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: { $cond: [{ $eq: ["$senderId", req.params.userId] }, "$receiverId", "$senderId"] },
        lastMessage: { $first: "$$ROOT" },
      },
    },
    { $limit: 50 },
  ];
  const convs = await db.collection("messages").aggregate(pipeline).toArray();

  // Batch-fetch all user docs instead of N+1
  const userIds = convs.map((c) => {
    try { return toObjectId(c._id); } catch { return null; }
  }).filter(Boolean);

  const users = userIds.length
    ? await db.collection("users").find({ _id: { $in: userIds } }).toArray()
    : [];
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  const result = convs
    .map((c) => {
      const other = userMap.get(c._id);
      if (!other) return null;
      return {
        userId: c._id,
        userName: other.name,
        lastMessage: serializeDoc(c.lastMessage),
      };
    })
    .filter(Boolean);

  res.json(result);
});

export default router;
