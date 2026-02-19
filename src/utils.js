import crypto from "crypto";
import mongoose from "mongoose";

const MPIN_SALT = process.env.MPIN_SALT;
if (!MPIN_SALT) {
  throw new Error("MPIN_SALT environment variable is required");
}

/** Create a mongoose ObjectId from hex string. Throws TypeError if invalid. */
export function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id ?? "");
  if (!mongoose.Types.ObjectId.isValid(s)) throw new TypeError(`Invalid ObjectId: ${s}`);
  return new mongoose.Types.ObjectId(s);
}

/**
 * Hash MPIN using PBKDF2 with a salt.
 * NOTE: This is a breaking change — existing users with SHA-256 hashes
 * will need to reset their MPIN. See migration notes.
 */
export function hashMpin(mpin) {
  return crypto.pbkdf2Sync(String(mpin || ""), MPIN_SALT, 100000, 64, "sha512").toString("hex");
}

/**
 * Ref field → friendly alias mapping.
 * When a lean() doc has `employer` (an ObjectId), we also produce `employerId` (string).
 */
const REF_ALIASES = {
  employer: "employerId",
  seeker: "seekerId",
  sender: "senderId",
  receiver: "receiverId",
  job: "jobId",
  user: "userId",
};

function isObjectId(v) {
  return v instanceof mongoose.Types.ObjectId
    || (v && typeof v === "object" && typeof v.toHexString === "function");
}

/**
 * Serialize a Mongoose document or plain object for JSON response.
 * - Converts _id to id
 * - Converts ObjectId ref fields to string aliases (employer → employerId)
 * - Strips __v and optionally mpinHash
 */
export function serializeDoc(doc, excludeSensitive = true) {
  if (!doc) return doc;
  const d = typeof doc.toJSON === "function" ? doc.toJSON() : { ...doc };

  if (d._id) {
    d.id = d._id.toString();
    delete d._id;
  }
  delete d.__v;

  // Convert ObjectId ref fields to string aliases
  for (const [field, alias] of Object.entries(REF_ALIASES)) {
    if (d[field] !== undefined && isObjectId(d[field])) {
      d[alias] = d[field].toString();
      delete d[field];
    }
  }

  if (excludeSensitive) delete d.mpinHash;
  return d;
}
