import { NextResponse, type NextRequest } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getDb } from '@/lib/db';
import { handleStripeEvent } from '@/lib/payments/webhook-handlers';
import { createMembershipRepo } from '@/lib/payments/membership-repo';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

/**
 * Stripe webhook — the AUTHORITATIVE payment signal. Never grant access on the
 * success redirect; it is granted here when `checkout.session.completed` fires.
 *
 * The membership slice is wired end-to-end: createMembershipCheckout (the
 * sender, lib/payments/checkout.ts) opens the session; this handler flips the
 * membership row to active. Extend the switch in
 * lib/payments/webhook-handlers.ts for new events — keep both ends in sync.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const signature = req.headers.get('stripe-signature');
  if (signature === null) {
    return NextResponse.json(
      { error: 'Missing stripe-signature header' },
      { status: 400 },
    );
  }

  const rawBody = await req.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  try {
    await handleStripeEvent(event, createMembershipRepo(getDb()));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Webhook handler failed: ${message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
