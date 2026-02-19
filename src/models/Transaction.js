import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    purchaseType: {
      type: String,
      enum: ["credit", "subscription", "ai_credits"],
      default: "credit",
      index: true,
    },
    itemCode: {
      type: String,
      default: "single_job",
      index: true,
    },
    creditsPurchased: {
      type: Number,
      default: 0,
    },
    aiTokensPurchased: {
      type: Number,
      default: 0,
    },
    subscriptionPlan: {
      type: String,
      enum: ["none", "monthly_unlimited"],
      default: "none",
    },
    subscriptionDays: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: "INR",
    },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    status: {
      type: String,
      enum: ["created", "success", "failed", "refunded"],
      default: "created",
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id.toString();
        ret.employerId = ret.employer?.toString?.() || ret.employer;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

transactionSchema.index(
  { employer: 1, razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: "string" } } }
);
transactionSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } }
);

export default mongoose.model("Transaction", transactionSchema);
