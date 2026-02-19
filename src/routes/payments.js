import { Router } from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import { User, Transaction } from "../models/index.js";
import { requireEmployer, requireUser } from "../middleware/auth.js";
import { invalidateUserCache } from "../middleware/jwt.js";
import {
  entitlementSnapshot,
  SUBSCRIPTION_MONTHLY,
  SUBSCRIPTION_NONE,
} from "../lib/employerEntitlements.js";
import { aiSnapshot } from "../lib/aiCredits.js";
import logger from "../lib/logger.js";

const router = Router();
const RAZORPAY_CURRENCY = "INR";

const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
const SUBSCRIPTION_DEFAULT_DAYS = Math.max(parseInt(process.env.SUBSCRIPTION_DEFAULT_DAYS || "30", 10), 1);

const OFFERINGS = {
  single_job: {
    itemCode: "single_job",
    label: "Single Job Credit",
    purchaseType: "credit",
    creditsPurchased: 1,
    amount: Math.max(parseInt(process.env.PAYMENT_SINGLE_JOB_AMOUNT_PAISE || "5000", 10), 100),
    currency: RAZORPAY_CURRENCY,
  },
  credits_5: {
    itemCode: "credits_5",
    label: "5 Job Credits",
    purchaseType: "credit",
    creditsPurchased: 5,
    amount: Math.max(parseInt(process.env.PAYMENT_CREDITS_5_AMOUNT_PAISE || "20000", 10), 100),
    currency: RAZORPAY_CURRENCY,
  },
  credits_20: {
    itemCode: "credits_20",
    label: "20 Job Credits",
    purchaseType: "credit",
    creditsPurchased: 20,
    amount: Math.max(parseInt(process.env.PAYMENT_CREDITS_20_AMOUNT_PAISE || "70000", 10), 100),
    currency: RAZORPAY_CURRENCY,
  },
  subscription_monthly: {
    itemCode: "subscription_monthly",
    label: "Monthly Unlimited Posting",
    purchaseType: "subscription",
    subscriptionPlan: SUBSCRIPTION_MONTHLY,
    subscriptionDays: SUBSCRIPTION_DEFAULT_DAYS,
    amount: Math.max(parseInt(process.env.PAYMENT_SUBSCRIPTION_MONTHLY_AMOUNT_PAISE || "99900", 10), 100),
    currency: RAZORPAY_CURRENCY,
  },
  ai_tokens_5k: {
    itemCode: "ai_tokens_5k",
    label: "5,000 AI Credits",
    purchaseType: "ai_credits",
    aiTokensPurchased: 5000,
    amount: Math.max(parseInt(process.env.PAYMENT_AI_TOKENS_5K_PAISE || "9900", 10), 100),
    currency: RAZORPAY_CURRENCY,
  },
};

let razorpayClient = null;
function getRazorpayClient() {
  if (razorpayClient) return razorpayClient;
  if (!razorpayKeyId || !razorpayKeySecret) return null;
  razorpayClient = new Razorpay({
    key_id: razorpayKeyId,
    key_secret: razorpayKeySecret,
  });
  return razorpayClient;
}

function timingSafeEqualHex(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function resolveOffering(itemCode) {
  const key = String(itemCode || "single_job").trim().toLowerCase();
  return OFFERINGS[key] || null;
}

router.get("/payments/catalog", requireUser, async (_req, res) => {
  res.json({
    razorpayEnabled: !!getRazorpayClient(),
    currency: RAZORPAY_CURRENCY,
    items: Object.values(OFFERINGS),
  });
});

router.get("/payments/entitlements", requireUser, async (req, res) => {
  const user = await User.findById(req.userId).lean();
  if (!user) return res.status(404).json({ detail: "User not found" });
  const job = user.role === "employer" ? entitlementSnapshot(user) : {
    freeJobsRemaining: 0,
    paidJobsRemaining: 0,
    subscriptionPlan: SUBSCRIPTION_NONE,
    subscriptionExpiresAt: null,
    subscriptionActive: false,
    canPost: false,
  };
  const ai = aiSnapshot(user);
  res.json({ ...job, ...ai });
});

router.post("/payments/create-order", requireUser, async (req, res) => {
  try {
    const userId = req.userId;
    const offering = resolveOffering(req.body?.itemCode);
    if (!offering) {
      return res.status(400).json({ detail: "Invalid itemCode" });
    }
    if ((offering.purchaseType === "credit" || offering.purchaseType === "subscription") && req.userRole !== "employer") {
      return res.status(403).json({ detail: "Only employers can purchase job credits or subscription" });
    }
    const amount = offering.amount;
    const client = getRazorpayClient();
    if (!client) {
      return res.status(500).json({ detail: "Payment gateway not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET." });
    }

    const order = await client.orders.create({
      amount,
      currency: offering.currency,
      receipt: `order_${Date.now()}_${String(userId).slice(-6)}`,
    });
    const orderId = order.id;

    await Transaction.create({
      employer: userId,
      amount,
      currency: offering.currency,
      purchaseType: offering.purchaseType,
      itemCode: offering.itemCode,
      creditsPurchased: offering.creditsPurchased || 0,
      aiTokensPurchased: offering.aiTokensPurchased || 0,
      subscriptionPlan: offering.subscriptionPlan || SUBSCRIPTION_NONE,
      subscriptionDays: offering.subscriptionDays || 0,
      razorpayOrderId: orderId,
      status: "created",
    });

    return res.json({
      id: orderId,
      keyId: razorpayKeyId || null,
      itemCode: offering.itemCode,
      label: offering.label,
      amount,
      currency: offering.currency,
      status: "created",
    });
  } catch (e) {
    logger.error({ err: e, itemCode: req.body?.itemCode }, "Create order failed");
    const message = e.code === 11000 ? "Duplicate order. Please retry." : (e.message || "Failed to create order");
    return res.status(500).json({ detail: message });
  }
});

router.post("/payments/verify", requireUser, async (req, res) => {
  const userId = req.userId;
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  if (!razorpayOrderId) {
    return res.status(400).json({ detail: "razorpayOrderId is required" });
  }

  const tx = await Transaction.findOne({
    employer: userId,
    razorpayOrderId,
  }).sort({ createdAt: -1 });

  if (!tx) {
    return res.status(400).json({ detail: "Order not found for this employer" });
  }
  if (tx.status === "success") {
    const user = await User.findById(userId).lean();
    const job = user?.role === "employer" ? entitlementSnapshot(user) : null;
    const ai = user ? aiSnapshot(user) : null;
    return res.json({
      success: true,
      message: "Payment already verified",
      itemCode: tx.itemCode,
      entitlements: user ? { ...(job || {}), ...ai } : null,
    });
  }

  const client = getRazorpayClient();
  if (!client) {
    return res.status(500).json({ detail: "Payment gateway not configured" });
  }
  if (!razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ detail: "Payment ID and signature are required" });
  }
  const expectedSignature = crypto
    .createHmac("sha256", razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  const verified = timingSafeEqualHex(expectedSignature, razorpaySignature);

  if (!verified) {
    await Transaction.findByIdAndUpdate(tx._id, {
      $set: {
        razorpayPaymentId: razorpayPaymentId || null,
        razorpaySignature: razorpaySignature || null,
        status: "failed",
      },
    });
    return res.status(400).json({ detail: "Invalid payment signature" });
  }

  const updatedTx = await Transaction.findOneAndUpdate(
    { _id: tx._id, status: "created" },
    {
      $set: {
        razorpayPaymentId: razorpayPaymentId || null,
        razorpaySignature: razorpaySignature || null,
        status: "success",
      },
    },
    { returnDocument: "after" }
  );

  if (!updatedTx) {
    const fresh = await Transaction.findById(tx._id).lean();
    if (fresh?.status === "success") {
      const user = await User.findById(userId).lean();
      const job = user?.role === "employer" ? entitlementSnapshot(user) : null;
      const ai = user ? aiSnapshot(user) : null;
      return res.json({
        success: true,
        message: "Payment already verified",
        itemCode: fresh.itemCode,
        entitlements: user ? { ...(job || {}), ...ai } : null,
      });
    }
    return res.status(409).json({ detail: "Payment verification conflict. Please retry." });
  }

  const targetUser = await User.findById(userId);
  if (!targetUser) return res.status(404).json({ detail: "User not found" });

  if (updatedTx.purchaseType === "subscription") {
    const now = new Date();
    const base = targetUser.subscriptionExpiresAt && targetUser.subscriptionExpiresAt > now
      ? targetUser.subscriptionExpiresAt
      : now;
    const days = Math.max(updatedTx.subscriptionDays || SUBSCRIPTION_DEFAULT_DAYS, 1);
    const nextExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    targetUser.subscriptionPlan = updatedTx.subscriptionPlan || SUBSCRIPTION_MONTHLY;
    targetUser.subscriptionExpiresAt = nextExpiry;
    await targetUser.save();
  } else if (updatedTx.purchaseType === "ai_credits") {
    const tokens = Math.max(parseInt(updatedTx.aiTokensPurchased, 10) || 0, 0);
    await User.findByIdAndUpdate(userId, { $inc: { aiPaidTokensRemaining: tokens } });
  } else {
    const credits = Math.max(parseInt(updatedTx.creditsPurchased, 10) || 0, 0);
    await User.findByIdAndUpdate(userId, { $inc: { paidJobsRemaining: credits } });
  }
  invalidateUserCache(userId);

  const freshUser = await User.findById(userId).lean();
  const job = freshUser?.role === "employer" ? entitlementSnapshot(freshUser) : null;
  const ai = freshUser ? aiSnapshot(freshUser) : null;
  res.json({
    success: true,
    message: "Payment verified",
    itemCode: updatedTx.itemCode,
    entitlements: freshUser ? { ...(job || {}), ...ai } : null,
  });
});

export default router;
