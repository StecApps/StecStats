import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Local mirror of the Clerk-managed identity, keyed by Clerk's user id.
// Clerk owns authentication/sessions entirely; this row exists so other
// tables can reference a stable local id (e.g. for future per-account data
// ownership) without depending on Clerk's id format directly.
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  // Stripe customer id for this account, if one has been created (lazily,
  // on first checkout). Subscription/plan status itself is never stored
  // here — it is derived on read from the `stripe.subscriptions` table that
  // stripe-replit-sync keeps in sync via webhooks, which is the source of
  // truth. See lib/entitlements.ts in api-server.
  stripeCustomerId: text("stripe_customer_id"),
  // Stored refresh token from the coach's personal YouTube OAuth consent.
  // Null when the coach has not connected YouTube yet.
  youtubeRefreshToken: text("youtube_refresh_token"),
  // Active entitlement(s) granted by RevenueCat (mobile) subscriptions.
  // Set by the RC webhook when a purchase or expiry event is received.
  // Value is a "+" compound string when multiple entitlements are active:
  //   "pro" | "premium" | "soccer" | "pro+soccer" | "premium+soccer" | null
  // null means no active mobile subscription.
  // Expiry events remove only the named entitlement — other parts are preserved.
  // Used as a fallback in getEntitlements() when there is no Stripe subscription.
  revenueCatEntitlement: text("revenue_cat_entitlement"),
  // Display name chosen by the coach — stored here because the Replit-managed
  // Clerk instance does not accept firstName/lastName writes from the client SDK.
  firstName: text("first_name"),
  lastName: text("last_name"),
  // Expo push token registered at app launch. Used to send push notifications
  // (e.g. "Your highlights are ready"). Null when the coach hasn't granted
  // notification permission yet or hasn't opened the app since the feature
  // was added.
  pushToken: text("push_token"),
  deletionPending: timestamp("deletion_pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
