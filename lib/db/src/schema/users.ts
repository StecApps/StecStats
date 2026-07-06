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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
