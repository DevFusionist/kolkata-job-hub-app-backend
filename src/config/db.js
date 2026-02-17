import mongoose from "mongoose";
import logger from "../lib/logger.js";

const url = process.env.MONGO_URL;
const dbName = process.env.DB_NAME;

export async function connectDb() {
  if (mongoose.connection.readyState >= 1) return mongoose.connection.db;
  const fullUrl = url.includes(dbName) ? url : `${url.replace(/\/[^/]*$/, "/")}${dbName}`;
  await mongoose.connect(fullUrl, { dbName });
  logger.info({ dbName }, "MongoDB connected");
  return mongoose.connection.db;
}

export function getDb() {
  return mongoose.connection.db;
}

export async function closeDb() {
  await mongoose.disconnect();
}
