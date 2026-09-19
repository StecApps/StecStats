import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { liveSessionsTable } from "./live-sessions";

export const livePublicEventsTable = pgTable("live_public_events", {
  id: serial("id").primaryKey(),
  liveSessionId: integer("live_session_id").notNull().references(() => liveSessionsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  applyAt: timestamp("apply_at").notNull(),
  status: text("status").notNull().default("queued"),
  claimToken: text("claim_token"),
  claimedUntil: timestamp("claimed_until"),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  due: index("live_public_events_due_idx").on(table.status, table.applyAt),
}));