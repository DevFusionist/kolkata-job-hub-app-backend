import mongoose from "mongoose";

const portfolioSchema = new mongoose.Schema(
  {
    seeker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    rawText: {
      type: String,
      default: "",
      maxlength: 10000,
    },
    projects: {
      type: [
        {
          name: { type: String, trim: true },
          description: { type: String, trim: true },
          url: { type: String, trim: true },
        },
      ],
      default: [],
    },
    links: {
      type: [String],
      default: [],
    },
    resumeUrl: {
      type: String,
      default: null,
    },
    resumeFileName: {
      type: String,
      default: null,
    },
    generatedResumeUrl: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id.toString();
        ret.seekerId = ret.seeker?.toString?.() || ret.seeker;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

export default mongoose.model("Portfolio", portfolioSchema);
