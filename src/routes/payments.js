import { Router } from "express";
import { User, Transaction } from "../models/index.js";
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

  await User.findByIdAndUpdate(employerId, { $inc: { freeJobsRemaining: 1 } });

  await Transaction.create({
    employer: employerId,
    amount: 5000,
    razorpayOrderId: razorpayOrderId || "",
    razorpayPaymentId: razorpayPaymentId || "",
    razorpaySignature: razorpaySignature || "",
    status: "success",
  });

  res.json({ success: true, message: "Payment verified" });
});

export default router;
