import mongoose from "mongoose";

const CATEGORIES = [
  "Sales", "Customer Service", "Driving", "Cooking", "Computer",
  "Accounting", "Warehouse", "Delivery", "Healthcare", "Education",
  "Construction", "Hospitality", "Retail", "Manufacturing",
  "Driver", "Restaurant", "Security", "Beautician", "Office Work", "Other",
];

const JOB_TYPES = ["Full-time", "Part-time", "Contract", "Temporary", "Internship"];
const EXPERIENCE_LEVELS = ["Fresher", "1-2 years", "3-5 years", "5+ years"];
const EDUCATION_LEVELS = ["None", "Any", "10th Pass", "12th Pass", "Graduate", "Post Graduate"];
const STATUSES = ["active", "closed", "paused"];

const jobSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      minlength: 3,
      maxlength: 100,
      trim: true,
    },
    category: {
      type: String,
      required: true,
      enum: CATEGORIES,
      index: true,
    },
    description: {
      type: String,
      required: true,
      minlength: 8,
      maxlength: 2000,
      trim: true,
    },
    salary: {
      type: String,
      required: true,
      trim: true,
    },
    salaryMin: {
      type: Number,
      default: 0,
      index: true,
    },
    salaryMax: {
      type: Number,
      default: 0,
    },
    location: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    jobType: {
      type: String,
      required: true,
      enum: JOB_TYPES,
      index: true,
    },
    experience: {
      type: String,
      required: true,
      enum: EXPERIENCE_LEVELS,
    },
    education: {
      type: String,
      default: "Any",
      enum: EDUCATION_LEVELS,
    },
    languages: {
      type: [String],
      required: true,
      validate: [arr => arr.length >= 1, "At least one language required"],
    },
    skills: {
      type: [String],
      required: true,
      validate: [arr => arr.length >= 1, "At least one skill required"],
      index: true,
    },
    employerId: {
      type: String,
      required: true,
      index: true,
    },
    employerName: { type: String, trim: true },
    employerPhone: { type: String },
    businessName: { type: String, trim: true },
    postedDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    status: {
      type: String,
      enum: STATUSES,
      default: "active",
      index: true,
    },
    applicationsCount: {
      type: Number,
      default: 0,
    },
    isPaid: {
      type: Boolean,
      default: false,
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
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

jobSchema.index({ status: 1, postedDate: -1 });
jobSchema.index({ status: 1, category: 1 });
jobSchema.index({ employerId: 1, postedDate: -1 });
jobSchema.index({ title: "text", description: "text", skills: "text" });

export { CATEGORIES, JOB_TYPES, EXPERIENCE_LEVELS, EDUCATION_LEVELS, STATUSES };
export default mongoose.model("Job", jobSchema);
