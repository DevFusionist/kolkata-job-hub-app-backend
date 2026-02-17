import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      match: /^\d{10}$/,
      index: true,
    },
    name: {
      type: String,
      required: true,
      minlength: 2,
      maxlength: 100,
      trim: true,
    },
    role: {
      type: String,
      required: true,
      enum: ["seeker", "employer"],
      index: true,
    },
    mpinHash: {
      type: String,
      default: null,
    },
    businessName: {
      type: String,
      trim: true,
      default: null,
    },
    freeJobsRemaining: {
      type: Number,
      default: 0,
    },
    location: {
      type: String,
      trim: true,
      default: "",
    },
    skills: {
      type: [String],
      default: [],
      validate: [arr => arr.length <= 30, "Max 30 skills"],
    },
    experience: {
      type: String,
      default: "Fresher",
    },
    languages: {
      type: [String],
      default: ["Bengali", "Hindi"],
    },
    aiExtracted: {
      skills: { type: [String], default: [] },
      experience: { type: String, default: "" },
      category: { type: String, default: "" },
      score: { type: Number, default: 0 },
    },
    preferredSalary: {
      min: { type: Number, default: 0 },
      max: { type: Number, default: 0 },
    },
    preferredLanguage: {
      type: String,
      enum: ["en", "bn"],
      default: "en",
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.mpinHash;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

userSchema.index({ "aiExtracted.skills": 1 });
userSchema.index({ location: 1 });
userSchema.index({ skills: 1 });

export default mongoose.model("User", userSchema);
