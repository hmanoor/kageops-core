'use client';

import { useState, useTransition } from 'react';
import { createMembershipCheckout } from '@/lib/payments/checkout';

/**
 * Join / pay page. The button calls the createMembershipCheckout Server Action
 * and redirects to Stripe's hosted Checkout. Customise the copy and benefits
 * from the brief — but DO NOT hardcode the price here; it comes from the Stripe
 * Price (STRIPE_PRICE_ID), so the amount is always real, never fabricated.
 */
export default function MembershipPage() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onJoin = (): void => {
    setError(null);
    startTransition(async () => {
      const result = await createMembershipCheckout();
      if ('url' in result) {
        window.location.href = result.url;
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Become a member</h1>
      <p className="text-center text-muted-foreground">
        {/* TODO: describe the membership benefits from the brief. */}
        Join to unlock members-only access.
      </p>
      <button
        onClick={onJoin}
        disabled={pending}
        className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Redirecting…' : 'Join now'}
      </button>
      {error !== null && <p className="text-sm text-red-500">{error}</p>}
    </main>
  );
}
