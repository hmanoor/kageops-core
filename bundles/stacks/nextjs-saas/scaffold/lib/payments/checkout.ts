'use server';

import { auth } from '@clerk/nextjs/server';
import { getStripe } from '@/lib/stripe';
import { buildCheckoutParams } from '@/lib/payments/checkout-params';

/**
 * Server Action: create a Stripe Checkout session for the signed-in user's
 * membership and return the hosted URL for the client to navigate to.
 *
 * This is the SENDING half of the payment slice — the webhook
 * (app/api/stripe/webhook/route.ts) is the RECEIVING half that flips the
 * membership row to active. Both must stay wired.
 *
 * Lazy SDK access via getStripe(); env read at call time (never module load).
 */
export async function createMembershipCheckout(): Promise<
  { readonly url: string } | { readonly error: string }
> {
  const { userId } = await auth();
  if (!userId) return { error: 'You must be signed in to start checkout.' };

  const priceId = process.env.STRIPE_PRICE_ID;
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!priceId || priceId.length === 0) {
    return { error: 'STRIPE_PRICE_ID is not set — create a Price in Stripe and set it.' };
  }
  if (!origin || origin.length === 0) {
    return { error: 'NEXT_PUBLIC_APP_URL is not set — set it to the deployed origin.' };
  }

  try {
    const session = await getStripe().checkout.sessions.create(
      buildCheckoutParams({ clerkId: userId, origin, priceId }),
    );
    if (!session.url) return { error: 'Stripe did not return a checkout URL.' };
    return { url: session.url };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Checkout failed.' };
  }
}
