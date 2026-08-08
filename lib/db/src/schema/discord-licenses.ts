import { createInsertSchema } from "drizzle-zod";
import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const discordLicensesTable = pgTable(
  "discord_licenses",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    guildUserUnique: uniqueIndex("discord_licenses_guild_user_idx").on(
      table.guildId,
      table.userId,
    ),
  }),
);

export const insertDiscordLicenseSchema = createInsertSchema(
  discordLicensesTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertDiscordLicense = z.infer<
  typeof insertDiscordLicenseSchema
>;
export type DiscordLicense = typeof discordLicensesTable.$inferSelect;