import mongoose from "mongoose";

const improvementLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["skill_added", "experience_rewrite", "career_goal_set", "trust_signal", "language_added", "profile_audit", "micro_improvement"],
      default: "micro_improvement",
    },
    scoreBefore: { type: Number, default: 0 },
    scoreAfter: { type: Number, default: 0 },
    scoreChange: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

improvementLogSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model("ImprovementLog", improvementLogSchema);
