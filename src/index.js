import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { connectDb, getDb, closeDb } from "./config/db.js";
import { setWsSendMessage } from "./routes/messages.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { verifyToken } from "./middleware/jwt.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import jobRoutes from "./routes/jobs.js";
import applicationRoutes from "./routes/applications.js";
import aiRoutes from "./routes/ai.js";
import portfolioRoutes from "./routes/portfolio.js";
import messageRoutes from "./routes/messages.js";
import paymentRoutes from "./routes/payments.js";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 8000;

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
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      // In dev mode, allow all
      if (process.env.NODE_ENV !== "production") return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
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

// JWT verification: runs on all /api routes, sets req.userId etc. if token present
app.use("/api", verifyToken);

// Health
app.get("/api/health", async (req, res) => {
  let dbStatus = "disconnected";
  try {
    const db = getDb();
    if (db) await db.command({ ping: 1 });
    dbStatus = "connected";
  } catch {}
  res.json({
    status: dbStatus === "connected" ? "healthy" : "degraded",
    database: dbStatus,
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

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ detail: err.message || "Internal server error" });
});

const server = app.listen(PORT, async () => {
  await connectDb();
  console.log(`Kolkata Job Hub API running on port ${PORT}`);
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
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const pathname = req.url?.split("?")[0] || "";
  const userId = pathname.replace(/^\/ws\/?/, "").split("/")[0];
  if (userId) {
    connections.set(userId, ws);
    console.log(`→ WS /ws/${userId} connected`);
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
      console.log(`← WS /ws/${userId} disconnected`);
    });
  }
});

setWsSendMessage((userId, message) => {
  const ws = connections.get(userId);
  if (ws?.readyState === 1) ws.send(JSON.stringify(message));
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await closeDb();
  server.close();
  process.exit(0);
});
