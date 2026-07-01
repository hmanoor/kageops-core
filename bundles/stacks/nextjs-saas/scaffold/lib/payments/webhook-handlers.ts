import type Stripe from 'stripe';

/**
 * Membership persistence interface the webhook depends on. Keeping the webhook
 * logic behind this interface lets it be unit-tested with a fake repo (no DB,
 * no network) — see tests/membership.test.ts. The Drizzle implementation is in
 * membership-repo.ts.
 */
export interface MembershipRepo {
  activate(args: {
    readonly clerkId: string;
    readonly stripeCustomerId: string | null;
    readonly stripeSubscriptionId: string | null;
    readonly currentPeriodEnd: Date | null;
  }): Promise<void>;
  setStatusBySubscriptionId(
    subscriptionId: string,
    status: 'active' | 'canceled',
    currentPeriodEnd: Date | null,
  ): Promise<void>;
}

/**
 * Pure event router for the membership payment slice. The webhook is the
 * AUTHORITATIVE payment signal — access is granted here, never on the success
 * redirect (which is spoofable).
 *
 * Returns `{ handled }` so callers/tests can assert which events did work.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  repo: MembershipRepo,
): Promise<{ readonly handled: boolean }> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const clerkId = session.metadata?.clerkId ?? session.client_reference_id ?? null;
      if (clerkId === null) return { handled: false };
      await repo.activate({
        clerkId,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
        stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
        currentPeriodEnd: null,
      });
      return { handled: true };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const active = sub.status === 'active' || sub.status === 'trialing';
      const periodEnd =
        typeof sub.current_period_end === 'number'
          ? new Date(sub.current_period_end * 1000)
          : null;
      await repo.setStatusBySubscriptionId(sub.id, active ? 'active' : 'canceled', periodEnd);
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}
