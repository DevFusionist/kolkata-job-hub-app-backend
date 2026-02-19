import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import { connectDb, closeDb } from "./config/db.js";
import { setWsSendMessage } from "./routes/messages.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { verifyToken, JWT_SECRET } from "./middleware/jwt.js";
import { sanitizeInput } from "./middleware/sanitize.js";
import logger from "./lib/logger.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import jobRoutes from "./routes/jobs.js";
import applicationRoutes from "./routes/applications.js";
import aiRoutes from "./routes/ai.js";
import portfolioRoutes from "./routes/portfolio.js";
import messageRoutes from "./routes/messages.js";
import paymentRoutes from "./routes/payments.js";
import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";

const app = express();
const PORT = process.env.PORT || 8000;

// Security headers
app.use(helmet());

// HTTPS redirect in production (behind reverse proxy)
if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    if (req.headers["x-forwarded-proto"] === "http") {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Allowed origins (add your frontend URLs)
const ALLOWED_ORIGINS = [
  "http://localhost:8081",
  "http://localhost:19006",
  "exp://localhost:8081",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      if (process.env.NODE_ENV !== "production") return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(sanitizeInput);
app.use(requestLogger);

// Global rate limiter: 100 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { detail: "Too many requests, please try again later" },
});
app.use("/api", globalLimiter);

// Stricter limiter for auth endpoints: 10 per minute
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { detail: "Too many auth attempts, please try again later" },
});
app.use("/api/auth", authLimiter);

// Per-user rate limiter: 60 requests/min per authenticated user (keyed by userId after JWT)
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId,
  skip: (req) => !req.userId,
  message: { detail: "Too many requests from this user, please try again later" },
});

// JWT verification: runs on all /api routes, sets req.userId etc. if token present
app.use("/api", verifyToken);
app.use("/api", userLimiter);

// Health
app.get("/api/health", async (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.json({
    status: dbReady ? "healthy" : "degraded",
    database: dbReady ? "connected" : "disconnected",
    service: "kolkata-job-platform",
    timestamp: new Date().toISOString(),
  });
});

// API routes (all under /api)
app.use("/api", authRoutes);
app.use("/api", userRoutes);
app.use("/api", jobRoutes);
app.use("/api", applicationRoutes);
app.use("/api", aiRoutes);
app.use("/api", portfolioRoutes);
app.use("/api", messageRoutes);
app.use("/api", paymentRoutes);

// 404
app.use((req, res) => res.status(404).json({ detail: "Not found" }));

// Global error handler
app.use((err, req, res, _next) => {
  logger.error({ err, method: req.method, url: req.originalUrl }, "Unhandled error");
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) {
    return res.status(500).json({ detail: "Internal server error" });
  }
  return res.status(status).json({ detail: err.message || "Request failed" });
});

const server = app.listen(PORT, async () => {
  await connectDb();
  logger.info({ port: PORT }, "Kolkata Job Hub API running");
});

// WebSocket: client connects to ws://host/ws/userId
const wss = new WebSocketServer({ noServer: true });
const connections = new Map();

server.on("upgrade", (req, socket, head) => {
  const pathname = req.url?.split("?")[0] || "";
  if (!pathname.startsWith("/ws/")) {
    socket.destroy();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const token = urlObj.searchParams.get("token");
  const requestedUserId = pathname.replace(/^\/ws\/?/, "").split("/")[0];

  if (!token) {
    logger.warn("WS auth failed: missing token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.userId !== requestedUserId) {
      logger.warn({ tokenUserId: decoded.userId, urlUserId: requestedUserId }, "WS auth mismatch");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    req._authenticatedUserId = decoded.userId;
  } catch {
    logger.warn("WS auth failed: invalid token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const userId = req._authenticatedUserId;
  if (userId) {
    connections.set(userId, ws);
    logger.info({ userId }, "WS connected");
    ws.on("message", (data) => {
      try {
        const obj = JSON.parse(data.toString());
        if (obj.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {}
    });
    ws.on("close", () => {
      connections.delete(userId);
      logger.info({ userId }, "WS disconnected");
    });
  }
});

setWsSendMessage((userId, message) => {
  const ws = connections.get(userId);
  if (ws?.readyState === 1) ws.send(JSON.stringify(message));
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  await closeDb();
  server.close();
  process.exit(0);
});
