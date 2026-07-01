You are extending an existing Next.js 16 App Router SaaS application.

Title: {{title}}
Description: {{description}}

The project is in a working state. A `npm run build` against the current
workspace passes. Your job is to add ONE feature without breaking that.

CURRENT WORKSPACE:

The workspace already contains the Next.js 16 + Clerk + Drizzle + Neon + Stripe +
shadcn baseline (see the create-ui prompt for the exhaustive file list). It also
contains any features added by previous Forge iterations. Read the workspace
before editing — DO NOT assume you know what's there.

THIS FEATURE:

{{description}}

YOUR JOB:

1. **Read first.** The workspace `lib/db/schema.ts` may have grown new tables;
   `app/` may have new routes; `middleware.ts` may have a new protected prefix.
   Before adding anything, list what's already there. Reuse where you can.

2. **Schema first.** If the feature needs persistence:
   - Add the new table(s) to `lib/db/schema.ts` (existing tables stay; don't
     rewrite them).
   - Add `type` exports for the new tables.
   - Run `npm run db:generate` (deferred — Vigil's verifier handles migration
     generation in CI; you just write the schema).

3. **Routes + UI:**
   - Page lives under `app/<feature-route>/page.tsx` — Server Component by
     default.
   - API endpoints live under `app/api/<feature>/route.ts` — `GET`, `POST` etc.
     exported as named async functions.
   - Mutations: prefer Server Actions over POST routes when the caller is your
     own UI. Use POST routes only when an external client (Stripe webhook,
     mobile app, scheduled job) needs them.

4. **Auth:**
   - All user-data routes/pages call `const { userId } = await auth();` from
     `@clerk/nextjs/server` and short-circuit on `null`.
   - If the new route needs auth at the middleware level, ADD its prefix to
     `isProtectedRoute` in `middleware.ts`. Existing prefixes (`/dashboard`,
     `/account`, `/api/protected`) stay.

5. **Server Actions:**
   - `'use server'` at the top of the file or function body.
   - Import `db` from `@/lib/db`, `auth` from `@clerk/nextjs/server`.
   - Return plain serialisable objects.
   - Use `revalidatePath()` or `revalidateTag()` from `next/cache` after writes
     so the UI updates without a manual refresh.

6. **shadcn components:**
   - Only `<Button>` ships in the scaffold. If the feature needs more (input,
     dialog, card, form, table, dropdown), add them by writing the canonical
     shadcn TSX into `components/ui/<name>.tsx`. Use the existing button.tsx
     as the reference for the cva + cn pattern.

7. **Stripe:**
   - A WORKING membership payment slice already ships in the scaffold: checkout
     Server Action (`lib/payments/checkout.ts` + `checkout-params.ts`) → Stripe
     Checkout → webhook (`lib/payments/webhook-handlers.ts`, called from
     `app/api/stripe/webhook/route.ts`) → `memberships.status = active` →
     protected `/members` route. **Extend or customise it — do NOT rebuild or
     duplicate it.** Add new event cases inside `handleStripeEvent`; add new
     paid features by reusing the existing checkout action / membership repo.
   - Never create a second webhook endpoint. Never grant access on the success
     redirect — the webhook is authoritative.
   - LAZY SDK INIT (DEPLOY-READINESS). NEVER construct an SDK client at module
     top level — no `const stripe = new Stripe(process.env.X!)` or
     `new SomeClient(process.env.Y!)` at import scope. `next build` evaluates
     module top-level code with NO runtime secrets present, so an eager
     construction crashes the build on a secret-less host. Use the scaffold's
     `getStripe()` (constructs on first call, inside the function) and apply the
     same defer-to-first-call pattern to any new SDK you add.
   - A webhook RECEIVER with no INITIATOR is an incomplete feature. If you add a
     handler for `checkout.session.completed`, you must also add the Server
     Action / route that CREATES the checkout session. Wire both ends.

8. **Tests:**
   - Add Vitest unit tests for Server Actions under `tests/<feature>.test.ts`.
   - Add a Playwright smoke test under `tests/e2e/<feature>.spec.ts` for any
     new page or interactive route.
   - The build verifier (P2-03) will run `npm run build` + `npm test` and
     route failures back to you as `build-fix` revision tasks.

   GENERATED TESTS MUST PASS (NON-NEGOTIABLE). `npm test` runs `vitest run` and
   the verifier blocks on ANY failing test — a red suite is a broken feature,
   not a finished one. Avoid the failures we have actually shipped:
   - Aliases: `@/...` resolves via `vitest.config.ts` at collection time. Use
     `import { x } from '@/lib/...'`, NEVER `require('@/lib/...')` in test setup
     (CJS `require` bypasses the alias → "Cannot find module"). Mock with
     `vi.mock('@/lib/x', ...)` and import the mocked value.
   - jsdom gaps (`URL.createObjectURL`, `matchMedia`, `ResizeObserver`,
     `scrollTo`) are ALREADY polyfilled in `tests/setup.ts`. Rely on it; don't
     redefine them.
   - Assert on stable hooks (`getByRole`, `getByLabelText`, `data-testid`), not
     over-broad text matchers like `getByText(/member/i)` that match many nodes.
   - `userEvent.upload` silently drops files whose type doesn't match the
     input's `accept`; use a matching file or `fireEvent.change` with a
     `FileList`.

NON-NEGOTIABLES (same as create-ui):

- DO NOT downgrade `package.json` deps or change the stack composition.
- DO NOT add a new auth/payment/UI/ORM library.
- DO NOT use `'use client'` unless the file actually needs hooks or browser APIs.
- DO NOT commit `.env*` files.
- TypeScript `strict: true`. No `any`.

EDIT-IN-PLACE RULE:

If a file exists in the workspace and you need to change it, output the
COMPLETE NEW FILE — not a diff. The writer overwrites. If you don't emit a
FILE block for a file, it stays unchanged.

OUTPUT FORMAT:

```
FILE: app/<route>/page.tsx
<full file content>

FILE: lib/db/schema.ts
<full file content with both old and new tables>
```

Begin.
