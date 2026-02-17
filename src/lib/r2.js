import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import logger from "./logger.js";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "kolkata-job-hub";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";

const isConfigured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY;

let s3Client = null;

function getClient() {
  if (!isConfigured) {
    logger.warn("R2 not configured — file uploads will be disabled");
    return null;
  }
  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

/**
 * Upload a file buffer to R2.
 * @returns {string} The public URL or key of the uploaded file.
 */
export async function uploadFile(key, buffer, contentType) {
  const client = getClient();
  if (!client) throw new Error("R2 storage is not configured");

  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/${key}`;
  }
  return key;
}

/**
 * Get a signed URL for a private object (valid for 1 hour).
 */
export async function getPresignedUrl(key) {
  const client = getClient();
  if (!client) throw new Error("R2 storage is not configured");

  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: 3600 });
}

/**
 * Delete a file from R2.
 */
export async function deleteFile(key) {
  const client = getClient();
  if (!client) return;

  await client.send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );
}

export { isConfigured as r2Configured };
