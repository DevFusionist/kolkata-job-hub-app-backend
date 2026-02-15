import { Router } from "express";
import { getDb } from "../config/db.js";
import { toObjectId } from "../utils.js";
import { requireEmployer } from "../middleware/auth.js";

const router = Router();

router.post("/payments/create-order", (req, res) => {
  const { amount } = req.body;
  const orderData = {
    id: `order_demo_${Date.now()}`,
    amount,
    currency: "INR",
    status: "created",
  };
  res.json(orderData);
});

router.post("/payments/verify", requireEmployer, async (req, res) => {
  const employerId = req.employerId;
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  const db = getDb();
  await db.collection("users").updateOne(
    { _id: toObjectId(employerId) },
    { $inc: { freeJobsRemaining: 1 } }
  );
  await db.collection("transactions").insertOne({
    employerId,
    amount: 5000,
    razorpayOrderId,
    razorpayPaymentId,
    status: "success",
    createdAt: new Date(),
  });
  res.json({ success: true, message: "Payment verified" });
});

export default router;
