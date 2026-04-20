import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const scoreHistory = sqliteTable("score_history", {
  date: text("date").primaryKey(),
  composite_score: real("composite_score"),
  regime: text("regime"),
  ks1: real("ks1"),
  ks2: real("ks2"),
  ks3: real("ks3"),
  ks4: real("ks4"),
  ig_hy: real("ig_hy"),
  vix: real("vix"),
  ks1_signal: integer("ks1_signal"),
  ks2_signal: integer("ks2_signal"),
  ks3_signal: integer("ks3_signal"),
  ks4_signal: integer("ks4_signal"),
  spy_price: real("spy_price"),
  hyg_price: real("hyg_price"),
  vix_value: real("vix_value"),
  totbkcr_yoy: real("totbkcr_yoy"),
});

export type ScoreHistory = typeof scoreHistory.$inferSelect;

// Legacy users table — kept to satisfy the scaffold template's storage.ts.
// Not used by the v3 routes; market data lives in `market_cache_v3.db`.
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

