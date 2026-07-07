import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const playersTable = pgTable("players", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Nullable at the DB level: pre-existing rows created before accounts
  // existed have no owner yet. They are claimed by the first user to sign in
  // (see requireAuth.ts) rather than backfilled by a one-off migration, since
  // we cannot know in advance which real account should own them. Every
  // create/read/write in application code always sets/filters this, so it is
  // effectively required post-claim.
  ownerId: integer("owner_id").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Player tracking photo — Premium feature. Stored in object storage.
  // photoUpdatedAt is set server-side whenever photoObjectPath is written so
  // the client can enforce the 6-month freshness prompt without trusting
  // client-supplied timestamps.
  photoObjectPath: text("photo_object_path"),
  photoUpdatedAt: timestamp("photo_updated_at"),
});

export const insertPlayerSchema = createInsertSchema(playersTable).omit({
  id: true,
  ownerId: true,
  createdAt: true,
});
export type InsertPlayer = z.infer<typeof insertPlayerSchema>;
export type Player = typeof playersTable.$inferSelect;
