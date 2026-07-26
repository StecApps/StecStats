import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const purchaseEventsTable = pgTable("purchase_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  email: text("email"),
  plan: text("plan").notNull(),
  interval: text("interval"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
