import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./backend/src/app";
import { createTestD1 } from "./backend/src/test/d1-sqlite";
import { MemoryCapLedger } from "./backend/src/modules/tracking/caps";
import { hashPassword } from "./backend/src/modules/auth/password";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = "0.0.0.0";

  // Initialize database with all migrations applied
  const db = createTestD1();
  const sharedLedger = new MemoryCapLedger();

  const honoApp = createApp({
    redirect: { ledger: sharedLedger },
    rateLimit: { enabled: true },
  });

  const env = {
    DB: db,
    APP_ENV: process.env.APP_ENV || "development",
    API_VERSION: "v1",
    CLICK_SIGNAL_SALT: process.env.CLICK_SIGNAL_SALT || "trafficvaulthub-click-salt-32-bytes-long",
    POSTBACK_SECRET_KEY: process.env.POSTBACK_SECRET_KEY || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };

  // Seed default platform organization and administrator
  await seedDefaultData(db);

  // Backend routing: forward API, tracking, and postback requests to Hono
  app.use(async (req, res, next) => {
    const isBackendRoute =
      req.url.startsWith("/api/") ||
      req.url.startsWith("/t/") ||
      req.url.startsWith("/s/") ||
      req.url.startsWith("/postback/");

    if (!isBackendRoute) {
      return next();
    }

    try {
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers.host || `localhost:${PORT}`;
      const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);

      let body: Buffer | undefined = undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      }

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val !== undefined) {
          if (Array.isArray(val)) {
            for (const v of val) headers.append(key, v);
          } else {
            headers.set(key, val);
          }
        }
      }

      const reqInit: RequestInit & { duplex?: string } = {
        method: req.method,
        headers,
      };

      if (body) {
        reqInit.body = new Uint8Array(body);
        reqInit.duplex = "half";
      }

      const webReq = new Request(url.toString(), reqInit);

      const webRes = await honoApp.fetch(webReq, env);

      res.status(webRes.status);
      webRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });

      const arrayBuffer = await webRes.arrayBuffer();
      res.end(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error("Error handling request in Hono app:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Server error" } });
      }
    }
  });

  // Frontend routing
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(distDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, host: HOST, port: PORT },
      appType: "spa",
      root: path.resolve(__dirname, "frontend"),
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`TrafficVaultHub server running at http://${HOST}:${PORT}`);
  });
}

async function seedDefaultData(db: any) {
  try {
    const existingOrg = await db
      .prepare("SELECT id FROM organizations WHERE type = 'PLATFORM' LIMIT 1")
      .first();

    let orgId = existingOrg?.id;
    if (!orgId) {
      orgId = "00000000-0000-4000-8000-000000000001";
      await db
        .prepare(
          "INSERT INTO organizations (id, type, name, slug) VALUES (?, 'PLATFORM', 'TrafficVaultHub Network', 'network')",
        )
        .bind(orgId)
        .run();
    }

    const adminEmail = "admin@trafficvaulthub.local";
    const existingUser = await db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?)")
      .bind(adminEmail)
      .first();

    if (!existingUser) {
      const userId = "00000000-0000-4000-8000-000000000002";
      const now = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO users (id, email, display_name, email_verified_at, status, timezone, locale) VALUES (?, ?, 'Platform Admin', ?, 'ACTIVE', 'UTC', 'en')",
        )
        .bind(userId, adminEmail, now)
        .run();

      const pwdHash = await hashPassword("correct-horse-battery-staple");
      await db
        .prepare("INSERT INTO user_credentials (id, user_id, password_hash) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), userId, pwdHash)
        .run();

      const SUPER_ADMIN_ROLE = "00000000-0000-4000-8000-000000000101";
      await db
        .prepare(
          "INSERT INTO organization_members (id, organization_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)"
        )
        .bind(crypto.randomUUID(), orgId, userId, SUPER_ADMIN_ROLE, now)
        .run();
    }
  } catch (err) {
    console.warn("Seeding initial platform data skipped or failed:", err);
  }
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
