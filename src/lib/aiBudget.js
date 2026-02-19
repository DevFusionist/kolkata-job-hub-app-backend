import logger from "./logger.js";

const MAX_INPUT_CHARS_PER_CALL = Math.max(parseInt(process.env.AI_MAX_INPUT_CHARS_PER_CALL || "12000", 10), 1000);
const MAX_OUTPUT_TOKENS_PER_CALL = Math.max(parseInt(process.env.AI_MAX_OUTPUT_TOKENS_PER_CALL || "350", 10), 50);
const MAX_EST_TOKENS_PER_USER_PER_DAY = Math.max(parseInt(process.env.AI_MAX_EST_TOKENS_PER_USER_PER_DAY || "20000", 10), 1000);
const MAX_EST_TOKENS_GLOBAL_PER_DAY = Math.max(parseInt(process.env.AI_MAX_EST_TOKENS_GLOBAL_PER_DAY || "500000", 10), 5000);
const ENABLE_AI_BUDGET = process.env.AI_BUDGET_DISABLED !== "true";

const userDailyUsage = new Map(); // `${userId}:${yyyy-mm-dd}` -> tokens
const globalDailyUsage = new Map(); // `${yyyy-mm-dd}` -> tokens

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text) {
  // Rough approximation (English-ish average): ~4 chars/token.
  return Math.ceil(String(text || "").length / 4);
}

function pruneOldEntries() {
  if (userDailyUsage.size < 5000 && globalDailyUsage.size < 32) return;
  const today = dayKey();
  for (const k of userDailyUsage.keys()) {
    if (!k.endsWith(`:${today}`)) userDailyUsage.delete(k);
  }
  for (const k of globalDailyUsage.keys()) {
    if (k !== today) globalDailyUsage.delete(k);
  }
}

export function clampAiOutputTokens(value, fallback = 250) {
  const n = Number.isFinite(Number(value)) ? parseInt(value, 10) : fallback;
  return Math.min(Math.max(n || fallback, 1), MAX_OUTPUT_TOKENS_PER_CALL);
}

export function truncateAiInput(text) {
  const s = String(text || "");
  if (s.length <= MAX_INPUT_CHARS_PER_CALL) return s;
  return s.slice(0, MAX_INPUT_CHARS_PER_CALL);
}

export function enforceAiBudget({ userId, promptText, maxOutputTokens }) {
  if (!ENABLE_AI_BUDGET) return { ok: true };
  const day = dayKey();
  const uid = String(userId || "anonymous");
  const userKey = `${uid}:${day}`;
  const estimated = estimateTokens(promptText) + Math.max(1, parseInt(maxOutputTokens || 0, 10));

  const usedByUser = userDailyUsage.get(userKey) || 0;
  if (usedByUser + estimated > MAX_EST_TOKENS_PER_USER_PER_DAY) {
    logger.warn(
      { userId: uid, estimated, usedByUser, maxPerDay: MAX_EST_TOKENS_PER_USER_PER_DAY },
      "AI budget exceeded for user"
    );
    return { ok: false, reason: "user_daily_budget_exceeded" };
  }

  const usedGlobal = globalDailyUsage.get(day) || 0;
  if (usedGlobal + estimated > MAX_EST_TOKENS_GLOBAL_PER_DAY) {
    logger.error(
      { estimated, usedGlobal, maxPerDay: MAX_EST_TOKENS_GLOBAL_PER_DAY },
      "AI global daily budget exceeded"
    );
    return { ok: false, reason: "global_daily_budget_exceeded" };
  }

  userDailyUsage.set(userKey, usedByUser + estimated);
  globalDailyUsage.set(day, usedGlobal + estimated);
  pruneOldEntries();
  return { ok: true };
}

