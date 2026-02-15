import { MongoClient } from "mongodb";

const url = process.env.MONGO_URL;
const dbName = process.env.DB_NAME;

let client;
let db;

export async function connectDb() {
  if (db) return db;
  client = new MongoClient(url);
  await client.connect();
  db = client.db(dbName);
  return db;
}

export function getDb() {
  return db;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
