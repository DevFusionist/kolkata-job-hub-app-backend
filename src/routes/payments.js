import { Router } from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import { User, Transaction } from "../models/index.js";
import { requireEmployer } from "../middleware/auth.js";
import { invalidateUserCache } from "../middleware/jwt.js";
import {
  entitlementSnapshot,
  SUBSCRIPTION_MONTHLY,
  SUBSCRIPTION_NONE,
} from "../lib/employerEntitlements.js";

const router = Router();
const RAZORPAY_CURRENCY = "INR";

const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
const demoPaymentsEnabled =
  process.env.NODE_ENV !== "production" && process.env.ALLOW_DEMO_PAYMENTS !== "false";
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

router.get("/payments/catalog", requireEmployer, async (_req, res) => {
  res.json({
    razorpayEnabled: !!getRazorpayClient(),
    demoPaymentsEnabled,
    currency: RAZORPAY_CURRENCY,
    items: Object.values(OFFERINGS),
  });
});

router.get("/payments/entitlements", requireEmployer, async (req, res) => {
  const user = await User.findById(req.employerId).lean();
  if (!user) return res.status(404).json({ detail: "Employer not found" });
  res.json(entitlementSnapshot(user));
});

router.post("/payments/create-order", requireEmployer, async (req, res) => {
  const employerId = req.employerId;
  const offering = resolveOffering(req.body?.itemCode);
  if (!offering) {
    return res.status(400).json({ detail: "Invalid itemCode" });
  }
  const amount = offering.amount;
  const client = getRazorpayClient();

  if (!client && !demoPaymentsEnabled) {
    return res.status(500).json({ detail: "Payment gateway not configured" });
  }

  let orderId;
  if (client) {
    const order = await client.orders.create({
      amount,
      currency: offering.currency,
      receipt: `job_${Date.now()}_${String(employerId).slice(-6)}`,
    });
    orderId = order.id;
  } else {
    orderId = `order_demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  await Transaction.create({
    employer: employerId,
    amount,
    currency: offering.currency,
    purchaseType: offering.purchaseType,
    itemCode: offering.itemCode,
    creditsPurchased: offering.creditsPurchased || 0,
    subscriptionPlan: offering.subscriptionPlan || SUBSCRIPTION_NONE,
    subscriptionDays: offering.subscriptionDays || 0,
    razorpayOrderId: orderId,
    status: "created",
  });

  res.json({
    id: orderId,
    keyId: razorpayKeyId || null,
    itemCode: offering.itemCode,
    label: offering.label,
    amount,
    currency: offering.currency,
    status: "created",
  });
});

router.post("/payments/verify", requireEmployer, async (req, res) => {
  const employerId = req.employerId;
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  if (!razorpayOrderId) {
    return res.status(400).json({ detail: "razorpayOrderId is required" });
  }

  const tx = await Transaction.findOne({
    employer: employerId,
    razorpayOrderId,
  }).sort({ createdAt: -1 });

  if (!tx) {
    return res.status(400).json({ detail: "Order not found for this employer" });
  }
  if (tx.status === "success") {
    const user = await User.findById(employerId).lean();
    return res.json({
      success: true,
      message: "Payment already verified",
      itemCode: tx.itemCode,
      entitlements: user ? entitlementSnapshot(user) : null,
    });
  }

  const client = getRazorpayClient();
  let verified = false;

  if (client) {
    if (!razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ detail: "Payment ID and signature are required" });
    }
    const expectedSignature = crypto
      .createHmac("sha256", razorpayKeySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");
    verified = timingSafeEqualHex(expectedSignature, razorpaySignature);
  } else if (demoPaymentsEnabled) {
    verified = razorpayPaymentId === "demo_payment_id" && razorpaySignature === "demo_signature";
  } else {
    return res.status(500).json({ detail: "Payment gateway not configured" });
  }

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
    { new: true }
  );

  if (!updatedTx) {
    const fresh = await Transaction.findById(tx._id).lean();
    if (fresh?.status === "success") {
      const user = await User.findById(employerId).lean();
      return res.json({
        success: true,
        message: "Payment already verified",
        itemCode: fresh.itemCode,
        entitlements: user ? entitlementSnapshot(user) : null,
      });
    }
    return res.status(409).json({ detail: "Payment verification conflict. Please retry." });
  }

  if (updatedTx.purchaseType === "subscription") {
    const employer = await User.findById(employerId);
    if (!employer) return res.status(404).json({ detail: "Employer not found" });
    const now = new Date();
    const base = employer.subscriptionExpiresAt && employer.subscriptionExpiresAt > now
      ? employer.subscriptionExpiresAt
      : now;
    const days = Math.max(updatedTx.subscriptionDays || SUBSCRIPTION_DEFAULT_DAYS, 1);
    const nextExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    employer.subscriptionPlan = updatedTx.subscriptionPlan || SUBSCRIPTION_MONTHLY;
    employer.subscriptionExpiresAt = nextExpiry;
    await employer.save();
  } else {
    const credits = Math.max(parseInt(updatedTx.creditsPurchased, 10) || 0, 0);
    await User.findByIdAndUpdate(employerId, { $inc: { paidJobsRemaining: credits } });
  }
  invalidateUserCache(employerId);

  const freshUser = await User.findById(employerId).lean();
  res.json({
    success: true,
    message: "Payment verified",
    itemCode: updatedTx.itemCode,
    entitlements: freshUser ? entitlementSnapshot(freshUser) : null,
  });
});

export default router;
