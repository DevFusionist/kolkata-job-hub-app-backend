import twilio from "twilio";
import logger from "./logger.js";

/**
 * Twilio Verify (built-in OTP). No manual code storage — Twilio sends and validates.
 * Dashboard → Verify → Create Service, then set TWILIO_VERIFY_SID.
 */

let client = null;

function getClient() {
  if (client) return client;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    logger.warn("TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set; Twilio disabled");
    return null;
  }
  client = twilio(accountSid, authToken);
  return client;
}

const getVerifySid = () =>
  process.env.TWILIO_VERIFY_SID;

export function isTwilioConfigured() {
  return !!getClient() && !!getVerifySid();
}

/**
 * Step 2: Send OTP via Twilio Verify (built-in; no manual storage).
 * @param {string} to - E.164 phone (e.g. +919876543210)
 */
export async function sendOtp(to) {
  const c = getClient();
  const serviceSid = getVerifySid();
  if (!c || !serviceSid) {
    return { success: false, message: "SMS service not configured" };
  }
  try {
    await c.verify.v2.services(serviceSid).verifications.create({
      to,
      channel: "sms",
    });
    return { success: true };
  } catch (e) {
    logger.warn({ err: e.message, to }, "Twilio send OTP failed");
    return { success: false, message: e.message || "Failed to send OTP" };
  }
}

/**
 * Step 3: Verify OTP via Twilio Verify (built-in check).
 * @param {string} to - E.164 phone
 * @param {string} code - User-entered OTP
 */
export async function verifyOtp(to, code) {
  const c = getClient();
  const serviceSid = getVerifySid();
  if (!c || !serviceSid) {
    return { success: false, message: "SMS service not configured" };
  }
  try {
    const result = await c.verify.v2
      .services(serviceSid)
      .verificationChecks.create({ to, code });
    return { success: result.status === "approved" };
  } catch (e) {
    logger.warn({ err: e.message, to }, "Twilio verify OTP failed");
    return { success: false, message: e.message || "Invalid or expired OTP" };
  }
}
