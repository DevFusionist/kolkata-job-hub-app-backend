import crypto from "crypto";
import { ObjectId } from "mongodb";

/** Create ObjectId from hex string. Throws if invalid. Use instead of deprecated new ObjectId(id). */
export function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  const s = String(id ?? "");
  if (!ObjectId.isValid(s)) throw new TypeError(`Invalid ObjectId: ${s}`);
  return ObjectId.createFromHexString(s);
}

export function hashMpin(mpin) {
  const salt = process.env.MPIN_SALT || "kolkata-job-hub-mpin-salt";
  return crypto.createHash("sha256").update(mpin + salt).digest("hex");
}

export function serializeDoc(doc, excludeSensitive = true) {
  if (!doc) return doc;
  const d = { ...doc };
  if (d._id) {
    d.id = d._id.toString();
    delete d._id;
  }
  if (excludeSensitive) delete d.mpinHash;
  return d;
}
