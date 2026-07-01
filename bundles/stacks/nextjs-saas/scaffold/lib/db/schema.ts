import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Example schema — Forge will add real tables here per the project brief.
// Keeping a `users` table seeded so Clerk user IDs have somewhere to live for
// app-specific metadata that doesn't belong in Clerk's publicMetadata.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerkId: text('clerk_id').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Membership / paid-access table — the working payment vertical ships wired.
// One row per Clerk user; `status` is the authoritative access flag that the
// Stripe webhook flips. Customise the table NAME and add domain columns per the
// brief, but keep `clerkId` + `status` + the stripe id columns — the checkout
// action, webhook handler, and protected route all depend on them.
export const memberships = pgTable('memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerkId: text('clerk_id').notNull().unique(),
  // 'inactive' (default) | 'active' | 'canceled'. Only 'active' grants access.
  status: text('status').notNull().default('inactive'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
