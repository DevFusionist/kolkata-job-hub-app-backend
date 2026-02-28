import { Router } from "express";
import { Message, User } from "../models/index.js";
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

  try {
    const receiver = await User.findById(receiverId).select("_id").lean();
    if (!receiver) return res.status(404).json({ detail: "Receiver not found" });
  } catch {
    return res.status(400).json({ detail: "Invalid receiverId" });
  }

  const msg = await Message.create({
    sender: senderId,
    receiver: receiverId,
    job: jobId || null,
    message: message.trim(),
    read: false,
  });

  const msgJson = msg.toJSON();
  wsSendMessage(receiverId, { type: "new_message", payload: msgJson });
  res.json(msgJson);
});

router.get("/messages/:userId", requireUser, async (req, res) => {
  if (req.params.userId !== req.userId) {
    return res.status(403).json({ detail: "You can only view your own messages" });
  }
  const otherUserId = req.query.other_user_id;
  if (!otherUserId) {
    return res.status(400).json({ detail: "other_user_id query param required" });
  }
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const skip = (page - 1) * limit;

  try {
    const userId = toObjectId(req.params.userId);
    const otherId = toObjectId(otherUserId);

    const messages = await Message.find({
      $or: [
        { sender: userId, receiver: otherId },
        { sender: otherId, receiver: userId },
      ],
    })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(messages.map((m) => ({ ...serializeDoc(m), timestamp: m.createdAt })));
  } catch (e) {
    if (e.name === "TypeError" || e.name === "CastError") {
      return res.status(400).json({ detail: "Invalid user ID" });
    }
    throw e;
  }
});

router.put("/messages/mark-read", requireUser, async (req, res) => {
  const userId = req.userId;
  const { otherUserId } = req.body;
  if (!otherUserId) {
    return res.status(400).json({ detail: "otherUserId is required" });
  }
  try {
    const result = await Message.updateMany(
      { sender: toObjectId(otherUserId), receiver: toObjectId(userId), read: false },
      { $set: { read: true } }
    );
    // Notify the sender via WebSocket that their messages were read
    if (result.modifiedCount > 0) {
      wsSendMessage(otherUserId, { type: "messages_read", payload: { readBy: userId } });
    }
    res.json({ updated: result.modifiedCount });
  } catch (e) {
    if (e.name === "CastError") {
      return res.status(400).json({ detail: "Invalid user ID" });
    }
    throw e;
  }
});

router.get("/messages/conversations/:userId", requireUser, async (req, res) => {
  if (req.params.userId !== req.userId) {
    return res.status(403).json({ detail: "You can only view your own conversations" });
  }
  try {
    const userId = toObjectId(req.params.userId);

    const pipeline = [
      { $match: { $or: [{ sender: userId }, { receiver: userId }] } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { $cond: [{ $eq: ["$sender", userId] }, "$receiver", "$sender"] },
          lastMessage: { $first: "$$ROOT" },
        },
      },
      { $limit: 50 },
    ];
    const convs = await Message.aggregate(pipeline);

    const userIds = convs.map(c => c._id).filter(Boolean);
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select("_id name").lean()
      : [];
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    const result = convs
      .map(c => {
        const other = userMap.get(c._id.toString());
        if (!other) return null;
        return {
          userId: c._id.toString(),
          userName: other.name,
          lastMessage: (() => { const lm = serializeDoc(c.lastMessage); return lm ? { ...lm, timestamp: lm.timestamp ?? lm.createdAt } : lm; })(),
        };
      })
      .filter(Boolean);

    res.json(result);
  } catch (e) {
    if (e.name === "TypeError" || e.name === "CastError") {
      return res.status(400).json({ detail: "Invalid user ID" });
    }
    throw e;
  }
});

export default router;
