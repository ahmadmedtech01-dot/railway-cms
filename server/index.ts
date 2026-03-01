import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { registerRoutes, recoverProcessingVideos } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { db } from "./db";
import { adminUsers, systemSettings } from "@shared/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

import fs from "fs";
import path from "path";

function crashLog(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  process.stderr.write(line);
  try { fs.appendFileSync("/tmp/vcms_crash.log", line); } catch {}
}

process.on("uncaughtException", (err) => {
  crashLog(`[FATAL] Uncaught Exception: ${err?.stack || err}`);
});

process.on("unhandledRejection", (reason: any) => {
  crashLog(`[FATAL] Unhandled Rejection: ${reason?.stack || reason}`);
});

// Allow SIGTERM to exit gracefully so the process manager (pid2) can restart
// the server cleanly rather than escalating to SIGKILL after a timeout.
// Note: Vite's misbehaviour uses process.exit(1) programmatically — not SIGTERM —
// so suppressing SIGTERM is unnecessary and harmful.
process.on("SIGTERM", () => {
  crashLog("[INFO] SIGTERM received — exiting gracefully");
  _originalExit(0);
});

process.on("SIGINT", () => {
  crashLog("[FATAL] SIGINT received");
  process.exit(0);
});

process.on("exit", (code) => {
  crashLog(`[FATAL] process 'exit' event fired with code ${code}`);
});

// Prevent Vite's customLogger from calling process.exit(1) on compilation
// errors (e.g. PostCSS warnings escalated to errors). Only allow clean
// exits (code 0) to propagate; all error exits are logged and suppressed.
const _originalExit = process.exit.bind(process);
(process as any).exit = (code?: number | string) => {
  const c = code === undefined ? 0 : Number(code);
  if (c === 0) {
    _originalExit(0);
  } else {
    crashLog(`[server] process.exit(${c}) suppressed — server kept alive`);
  }
};

const app = express();
const httpServer = createServer(app);

// Trust reverse proxies (Replit, Vercel, nginx) so req.ip and
// HTTPS-only cookies work correctly behind load balancers.
app.set("trust proxy", 1);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-session" {
  interface SessionData {
    adminId: string;
    adminEmail: string;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const isDevMode = process.env.NODE_ENV !== "production";
  const replitDomain = (process.env.REPLIT_DOMAINS || "").split(",").some(d => origin.includes(d.trim()));
  const isAllowed = isDevMode || replitDomain || ALLOWED_ORIGINS.includes(origin) || !origin;

  if (isAllowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-embed-referrer");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "secure-video-cms-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
    },
  })
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 300) logLine = logLine.slice(0, 300) + "...";
      log(logLine);
    }
  });

  next();
});

async function seedAdmin() {
  try {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) return;
    const existing = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
    if (existing.length === 0) {
      const passwordHash = await bcrypt.hash(password, 12);
      await db.insert(adminUsers).values({ email, passwordHash });
      log(`Admin user seeded: ${email}`);
    }
  } catch (e) {
    log(`Seed admin error: ${e}`);
  }
}

async function seedDefaultSettings() {
  try {
    const defaults = [
      { key: "global_kill_switch", value: "false" },
      { key: "aws_access_key_id", value: "" },
      { key: "aws_secret_access_key", value: "" },
      { key: "aws_region", value: "us-east-1" },
      { key: "s3_bucket", value: "" },
      { key: "s3_private_prefix", value: "raw/" },
      { key: "s3_hls_prefix", value: "hls/" },
      { key: "signing_secret", value: process.env.SIGNING_SECRET || "" },
      { key: "ffmpeg_enabled", value: "true" },
      { key: "max_upload_size_mb", value: "2048" },
    ];
    for (const d of defaults) {
      const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, d.key));
      if (existing.length === 0) {
        await db.insert(systemSettings).values(d);
      }
    }
  } catch (e) {
    log(`Seed settings error: ${e}`);
  }
}

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  // Pre-warm the database connection pool so SSL handshake to Supabase
  // completes before Vite starts compiling the frontend on first browser load.
  if (process.env.SUPABASE_DATABASE_URL) {
    try {
      await pool.query("SELECT 1");
      log("Supabase connection pre-warmed");
    } catch (e) {
      log(`Supabase pre-warm warning: ${e}`);
    }
  }

  // Use pre-built frontend if available (avoids Vite JIT compilation CPU spike).
  // import.meta.dirname is ESM-only; __dirname is CJS-only (compiled bundle).
  // Gracefully handle both environments.
  // Only run pre-build check in development (tsx/ESM) — in production the
  // serveStatic() function correctly resolves paths via __dirname internally.
  let hasBuild = false;
  let builtFrontend = "";
  if (process.env.NODE_ENV !== "production") {
    try {
      const selfDir = import.meta.dirname ?? "";
      builtFrontend = path.resolve(selfDir, "..", "dist", "public");
      hasBuild = selfDir !== "" && fs.existsSync(path.join(builtFrontend, "index.html"));
    } catch {
      hasBuild = false;
    }
  }

  if (hasBuild) {
    log("Serving pre-built frontend from dist/public");
    app.use(express.static(builtFrontend));
    app.use("/{*path}", (_req, res) => {
      res.sendFile(path.join(builtFrontend, "index.html"));
    });
  } else if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen({ port, host: "0.0.0.0", reusePort: true }, async () => {
    log(`serving on port ${port}`);
    console.log("[security] SIGNING_SECRET loaded:", !!process.env.SIGNING_SECRET);
    await seedAdmin();
    await seedDefaultSettings();
    recoverProcessingVideos();
  });
})();
