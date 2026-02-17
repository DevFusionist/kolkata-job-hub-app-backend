import mongoose from "mongoose";

const APPLICATION_STATUSES = ["pending", "shortlisted", "rejected", "hired"];

const applicationSchema = new mongoose.Schema(
  {
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
      index: true,
    },
    seeker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    seekerName: { type: String, trim: true },
    seekerPhone: { type: String },
    seekerSkills: { type: [String], default: [] },
    coverLetter: {
      type: String,
      maxlength: 2000,
      default: "",
    },
    status: {
      type: String,
      enum: APPLICATION_STATUSES,
      default: "pending",
      index: true,
    },
    appliedDate: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id.toString();
        ret.jobId = ret.job?.toString?.() || ret.job;
        ret.seekerId = ret.seeker?.toString?.() || ret.seeker;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// Prevent duplicate applications
applicationSchema.index({ job: 1, seeker: 1 }, { unique: true });
applicationSchema.index({ seeker: 1, appliedDate: -1 });

export { APPLICATION_STATUSES };
export default mongoose.model("Application", applicationSchema);
