import { eq } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { memberships } from '@/lib/db/schema';
import type { MembershipRepo } from '@/lib/payments/webhook-handlers';

/**
 * Drizzle implementation of MembershipRepo. Constructed per-request with the
 * lazy db (getDb()). Upsert on clerkId so a re-subscribe reactivates the same
 * row rather than duplicating it.
 */
export function createMembershipRepo(db: DB): MembershipRepo {
  return {
    async activate(args) {
      const now = new Date();
      await db
        .insert(memberships)
        .values({
          clerkId: args.clerkId,
          status: 'active',
          stripeCustomerId: args.stripeCustomerId,
          stripeSubscriptionId: args.stripeSubscriptionId,
          currentPeriodEnd: args.currentPeriodEnd,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: memberships.clerkId,
          set: {
            status: 'active',
            stripeCustomerId: args.stripeCustomerId,
            stripeSubscriptionId: args.stripeSubscriptionId,
            currentPeriodEnd: args.currentPeriodEnd,
            updatedAt: now,
          },
        });
    },
    async setStatusBySubscriptionId(subscriptionId, status, currentPeriodEnd) {
      await db
        .update(memberships)
        .set({ status, currentPeriodEnd, updatedAt: new Date() })
        .where(eq(memberships.stripeSubscriptionId, subscriptionId));
    },
  };
}

/** Read the authoritative access status for a Clerk user. */
export async function getMembershipStatus(db: DB, clerkId: string): Promise<string> {
  const rows = await db
    .select({ status: memberships.status })
    .from(memberships)
    .where(eq(memberships.clerkId, clerkId))
    .limit(1);
  return rows[0]?.status ?? 'inactive';
}
