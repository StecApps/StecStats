import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { eq } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./lib/webhookHandlers";
import { handleRevenueCatWebhook } from "./routes/revenuecat-webhook";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

// Admin reset endpoint — protected by ADMIN_RESET_SECRET header.
// Used to cancel stuck highlight/lowlight jobs without needing a Clerk session.
app.post("/api/admin/games/:gameId/cancel-reels", express.json(), async (req, res) => {
  const secret = process.env["ADMIN_RESET_SECRET"];
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const gameId = Number(req.params["gameId"]);
  if (!Number.isInteger(gameId)) { res.status(400).json({ error: "Invalid gameId" }); return; }
  await db.update(gamesTable).set({
    highlightStatus: null, highlightStartedAt: null, highlightError: null,
    lowlightStatus: null, lowlightStartedAt: null, lowlightError: null,
  }).where(eq(gamesTable.id, gameId));
  logger.info({ gameId }, "Admin: reel jobs cancelled");
  res.json({ ok: true });
});

// RevenueCat webhook — registered before express.json() so the raw Buffer is
// available if HMAC signature verification is added later. The handler itself
// parses JSON from the Buffer.
app.post(
  "/api/revenuecat/webhook",
  express.raw({ type: "*/*" }),
  handleRevenueCatWebhook,
);

// Stripe webhook route MUST be registered before express.json() below —
// it needs the raw request Buffer to verify the signature. This webhook is
// the source of truth for subscription/plan state; never trust a
// client-side checkout success redirect instead.
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (error) {
      logger.error({ err: error }, "Stripe webhook processing failed");
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
