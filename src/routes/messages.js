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
  const db = getDb();
  const msg = {
    receiverId,
    jobId,
    message,
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
    message,
    jobId: jobId || "",
    timestamp: msg.timestamp.toISOString(),
    read: false,
  };
  wsSendMessage(receiverId, { type: "new_message", payload: msgForWs });
  res.json({ ...msg, timestamp: msgForWs.timestamp });
});

router.get("/messages/:userId", async (req, res) => {
  const otherUserId = req.query.other_user_id;
  const db = getDb();
  const messages = await db.collection("messages")
    .find({
      $or: [
        { senderId: req.params.userId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: req.params.userId },
      ],
    })
    .sort({ timestamp: 1 })
    .limit(1000)
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
  ];
  const convs = await db.collection("messages").aggregate(pipeline).limit(100).toArray();
  const result = [];
  for (const c of convs) {
    const other = await db.collection("users").findOne({ _id: toObjectId(c._id) });
    if (other) {
      result.push({
        userId: c._id,
        userName: other.name,
        lastMessage: serializeDoc(c.lastMessage),
      });
    }
  }
  res.json(result);
});

export default router;
