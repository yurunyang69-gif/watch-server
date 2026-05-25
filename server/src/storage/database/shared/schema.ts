import { pgTable, serial, timestamp, varchar, text, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
	id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
	device_id: varchar("device_id", { length: 64 }).notNull(),
	type: varchar("type", { length: 20 }).notNull(),
	text: text("text").notNull(),
	created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("chat_messages_device_id_idx").on(table.device_id),
	index("chat_messages_created_at_idx").on(table.created_at),
]);
