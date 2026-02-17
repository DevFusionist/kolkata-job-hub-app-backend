import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      default: null,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { _id: false, timestamps: false }
);

const chatSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    messages: {
      type: [chatMessageSchema],
      default: [],
    },
    lastJobIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
    jobDraft: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    memory: {
      preferredLocation: { type: String, default: "" },
      preferredCategory: { type: String, default: "" },
      lastSearchFilters: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id.toString();
        ret.userId = ret.user?.toString?.() || ret.user;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

chatSessionSchema.index({ user: 1, active: 1 });
chatSessionSchema.index({ updatedAt: -1 });

export default mongoose.model("ChatSession", chatSessionSchema);
