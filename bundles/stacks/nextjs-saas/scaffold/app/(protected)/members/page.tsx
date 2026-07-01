import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getMembershipStatus } from '@/lib/payments/membership-repo';

// Per-user auth + DB read — never static. Without this, `next build` tries to
// prerender the page and Clerk throws "Missing publishableKey" on a secret-less
// build host (Vercel build step). Forcing dynamic also matches reality: the
// page depends on the request's session and a live DB row.
export const dynamic = 'force-dynamic';

/**
 * Members-only page. Gated TWICE: middleware.ts requires a signed-in user for
 * `/members`, and this server component additionally requires an ACTIVE
 * membership (the status the webhook set) — a signed-in non-member is bounced
 * to /membership to pay. This is the READING end of the slice; if you rename
 * the route, update the middleware matcher too.
 */
export default async function MembersPage() {
  const { userId } = await auth();
  if (userId === null) redirect('/sign-in');

  const status = await getMembershipStatus(getDb(), userId);
  if (status !== 'active') redirect('/membership');

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">Members area</h1>
      <p className="text-center text-muted-foreground">
        {/* TODO: the real members-only content from the brief goes here. */}
        Your membership is active. Welcome.
      </p>
    </main>
  );
}
