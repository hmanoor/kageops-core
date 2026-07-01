import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';

import { buildCheckoutParams } from '@/lib/payments/checkout-params';
import { handleStripeEvent, type MembershipRepo } from '@/lib/payments/webhook-handlers';

describe('buildCheckoutParams() — the checkout (sender) half', () => {
  it('builds a subscription session tied to the Clerk user', () => {
    const params = buildCheckoutParams({
      clerkId: 'user_123',
      origin: 'https://app.test',
      priceId: 'price_abc',
    });
    expect(params.mode).toBe('subscription');
    expect(params.line_items?.[0]).toMatchObject({ price: 'price_abc', quantity: 1 });
    // the webhook ties the completed checkout back to the user via this id
    expect(params.metadata?.clerkId).toBe('user_123');
    expect(params.client_reference_id).toBe('user_123');
    expect(params.success_url).toContain('/members');
    expect(params.cancel_url).toContain('/membership');
  });
});

/** A spy repo capturing what the webhook would persist. */
function fakeRepo() {
  return {
    activate: vi.fn(async () => {}),
    setStatusBySubscriptionId: vi.fn(async () => {}),
  } satisfies MembershipRepo;
}

describe('handleStripeEvent() — the webhook (receiver) half', () => {
  it('activates the membership on checkout.session.completed', async () => {
    const repo = fakeRepo();
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { clerkId: 'user_123' },
          client_reference_id: 'user_123',
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    } as unknown as Stripe.Event;

    const result = await handleStripeEvent(event, repo);

    expect(result.handled).toBe(true);
    expect(repo.activate).toHaveBeenCalledTimes(1);
    expect(repo.activate).toHaveBeenCalledWith({
      clerkId: 'user_123',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      currentPeriodEnd: null,
    });
  });

  it('does not activate when no Clerk id can be resolved', async () => {
    const repo = fakeRepo();
    const event = {
      type: 'checkout.session.completed',
      data: { object: { metadata: {}, client_reference_id: null } },
    } as unknown as Stripe.Event;

    const result = await handleStripeEvent(event, repo);
    expect(result.handled).toBe(false);
    expect(repo.activate).not.toHaveBeenCalled();
  });

  it('cancels the membership when the subscription is deleted', async () => {
    const repo = fakeRepo();
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', status: 'canceled', current_period_end: 1893456000 } },
    } as unknown as Stripe.Event;

    const result = await handleStripeEvent(event, repo);
    expect(result.handled).toBe(true);
    expect(repo.setStatusBySubscriptionId).toHaveBeenCalledWith('sub_1', 'canceled', expect.any(Date));
  });

  it('keeps the membership active on a subscription.updated that is still active', async () => {
    const repo = fakeRepo();
    const event = {
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', current_period_end: 1893456000 } },
    } as unknown as Stripe.Event;

    await handleStripeEvent(event, repo);
    expect(repo.setStatusBySubscriptionId).toHaveBeenCalledWith('sub_1', 'active', expect.any(Date));
  });

  it('ignores unrelated events', async () => {
    const repo = fakeRepo();
    const event = { type: 'payment_intent.created', data: { object: {} } } as unknown as Stripe.Event;
    const result = await handleStripeEvent(event, repo);
    expect(result.handled).toBe(false);
  });
});
