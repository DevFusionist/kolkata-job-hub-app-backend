/**
 * AI credits: consume aiFreeTokensRemaining first, then aiPaidTokensRemaining.
 * Reserve before AI call; consume after success; rollback on failure.
 */

import { User } from "../models/index.js";
import logger from "./logger.js";

const AI_FREE_TOKENS_DEFAULT = Math.max(
  parseInt(process.env.AI_FREE_TOKENS_LIFETIME || "6000", 10),
  0
);

/**
 * @param {object} user - User doc (lean)
 * @returns {{ aiFreeTokensRemaining: number, aiPaidTokensRemaining: number, canUseAi: boolean }}
 */
export function aiSnapshot(user) {
  const free = Math.max(0, parseInt(user?.aiFreeTokensRemaining, 10) ?? AI_FREE_TOKENS_DEFAULT);
  const paid = Math.max(0, parseInt(user?.aiPaidTokensRemaining, 10) || 0);
  return {
    aiFreeTokensRemaining: free,
    aiPaidTokensRemaining: paid,
    canUseAi: free + paid > 0,
  };
}

/**
 * Reserve AI tokens for a call (atomic). Uses free first, then paid.
 * @param {string} userId
 * @param {number} estimatedTokens
 * @returns {Promise<{ ok: boolean, source?: 'free'|'paid', user?: object }>}
 */
export async function reserveAiCredits(userId, estimatedTokens) {
  const tokens = Math.max(1, parseInt(estimatedTokens, 10) || 100);

  const freeUser = await User.findOneAndUpdate(
    { _id: userId, aiFreeTokensRemaining: { $gte: tokens } },
    { $inc: { aiFreeTokensRemaining: -tokens } },
    { returnDocument: "after" }
  ).lean();
  if (freeUser) {
    return { ok: true, source: "free", user: freeUser, tokensReserved: tokens };
  }

  const paidUser = await User.findOneAndUpdate(
    { _id: userId, aiPaidTokensRemaining: { $gte: tokens } },
    { $inc: { aiPaidTokensRemaining: -tokens } },
    { returnDocument: "after" }
  ).lean();
  if (paidUser) {
    return { ok: true, source: "paid", user: paidUser, tokensReserved: tokens };
  }

  const user = await User.findById(userId).lean();
  logger.warn(
    { userId, estimatedTokens: tokens, free: user?.aiFreeTokensRemaining, paid: user?.aiPaidTokensRemaining },
    "AI credits insufficient"
  );
  return { ok: false, source: null, user: user || null };
}

/**
 * Rollback a reservation (e.g. AI call failed after reserve).
 * @param {string} userId
 * @param {'free'|'paid'} source
 * @param {number} tokens
 */
export async function rollbackAiCredits(userId, source, tokens) {
  const t = Math.max(0, parseInt(tokens, 10) || 0);
  if (t === 0) return;
  if (source === "free") {
    await User.findByIdAndUpdate(userId, { $inc: { aiFreeTokensRemaining: t } });
  } else if (source === "paid") {
    await User.findByIdAndUpdate(userId, { $inc: { aiPaidTokensRemaining: t } });
  }
}
