import type Stripe from 'stripe';

/**
 * Pure builder for the membership Stripe Checkout session params.
 *
 * Kept in a plain module (NOT a 'use server' file, which may only export async
 * functions) so it is unit-testable without Stripe/Clerk in scope. The webhook
 * reads `metadata.clerkId` to tie the completed checkout back to the Clerk user
 * — keep that mapping if you customise this.
 *
 * Mode is `subscription` (recurring membership / dues). For a one-time payment
 * instead, change `mode` to `'payment'` and drop `subscription_data`.
 */
export function buildCheckoutParams(opts: {
  readonly clerkId: string;
  readonly origin: string;
  readonly priceId: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'subscription',
    line_items: [{ price: opts.priceId, quantity: 1 }],
    success_url: `${opts.origin}/members?checkout=success`,
    cancel_url: `${opts.origin}/membership?checkout=cancelled`,
    client_reference_id: opts.clerkId,
    metadata: { clerkId: opts.clerkId },
    subscription_data: { metadata: { clerkId: opts.clerkId } },
  };
}
