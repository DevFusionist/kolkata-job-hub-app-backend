import { User } from "../models/index.js";

export const SUBSCRIPTION_NONE = "none";
export const SUBSCRIPTION_MONTHLY = "monthly_unlimited";
const FREE_JOB_TRIAL_LIMIT = Math.max(parseInt(process.env.FREE_JOB_TRIAL_LIMIT || "2", 10), 0);

export function isSubscriptionActive(user, now = new Date()) {
  return (
    user?.subscriptionPlan
    && user.subscriptionPlan !== SUBSCRIPTION_NONE
    && user.subscriptionExpiresAt
    && new Date(user.subscriptionExpiresAt) > now
  );
}

export async function reserveJobPostingQuota(employerId) {
  const now = new Date();

  // Backward-compat hardening: cap legacy inflated free credits.
  await User.updateOne(
    { _id: employerId, role: "employer", freeJobsRemaining: { $gt: FREE_JOB_TRIAL_LIMIT } },
    { $set: { freeJobsRemaining: FREE_JOB_TRIAL_LIMIT } }
  );

  // Active subscription: no credit decrement.
  const subUser = await User.findOne({
    _id: employerId,
    role: "employer",
    subscriptionPlan: { $ne: SUBSCRIPTION_NONE },
    subscriptionExpiresAt: { $gt: now },
  }).lean();
  if (subUser) {
    return { ok: true, source: "subscription", user: subUser };
  }

  // Free credits first.
  const freeUser = await User.findOneAndUpdate(
    { _id: employerId, role: "employer", freeJobsRemaining: { $gt: 0 } },
    { $inc: { freeJobsRemaining: -1 } },
    { returnDocument: "after" }
  ).lean();
  if (freeUser) {
    return { ok: true, source: "free", user: freeUser };
  }

  // Paid credits next.
  const paidUser = await User.findOneAndUpdate(
    { _id: employerId, role: "employer", paidJobsRemaining: { $gt: 0 } },
    { $inc: { paidJobsRemaining: -1 } },
    { returnDocument: "after" }
  ).lean();
  if (paidUser) {
    return { ok: true, source: "paid", user: paidUser };
  }

  return { ok: false, source: null, user: null };
}

export async function rollbackJobPostingQuota(employerId, source) {
  if (source === "free") {
    await User.findByIdAndUpdate(employerId, { $inc: { freeJobsRemaining: 1 } });
  } else if (source === "paid") {
    await User.findByIdAndUpdate(employerId, { $inc: { paidJobsRemaining: 1 } });
  }
}

export function entitlementSnapshot(user) {
  const now = new Date();
  const subscriptionActive = isSubscriptionActive(user, now);
  const freeJobsRemaining = Math.min(
    FREE_JOB_TRIAL_LIMIT,
    Math.max(0, parseInt(user?.freeJobsRemaining, 10) || 0)
  );
  const paidJobsRemaining = Math.max(0, parseInt(user?.paidJobsRemaining, 10) || 0);
  return {
    freeJobsRemaining,
    paidJobsRemaining,
    subscriptionPlan: user?.subscriptionPlan || SUBSCRIPTION_NONE,
    subscriptionExpiresAt: user?.subscriptionExpiresAt || null,
    subscriptionActive,
    canPost: subscriptionActive
      || freeJobsRemaining > 0
      || paidJobsRemaining > 0,
  };
}
