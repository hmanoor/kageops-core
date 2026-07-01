You are extending a Next.js 16 App Router SaaS scaffold to match the brief.

Title: {{title}}
Description: {{description}}

THE SCAFFOLD ALREADY EXISTS. The following files are already in the workspace
and you MUST NOT recreate them from scratch. Edit them in place where needed.
Add new files where the brief requires new functionality.

EXISTING SCAFFOLD (do not delete or recreate):
- `package.json` — deps for Next 16, React 19, Clerk, Drizzle, Neon, Stripe, shadcn, Vitest, Playwright
- `tsconfig.json` · `next.config.ts` · `tailwind.config.ts` · `postcss.config.mjs`
- `drizzle.config.ts` · `vitest.config.ts` · `playwright.config.ts` · `components.json`
- `middleware.ts` — Clerk `clerkMiddleware()` with `/dashboard`, `/account`, `/api/protected` already protected
- `app/layout.tsx` — root layout with `<ClerkProvider>` + Tailwind body classes
- `app/page.tsx` — homepage with Sign in / UserButton (Clerk's `<SignedIn>` / `<SignedOut>`)
- `app/globals.css` — Tailwind base + shadcn CSS variables (light + dark theme)
- `app/(auth)/sign-in/[[...sign-in]]/page.tsx` — Clerk `<SignIn />` page
- `app/(auth)/sign-up/[[...sign-up]]/page.tsx` — Clerk `<SignUp />` page
- `app/api/stripe/webhook/route.ts` — Stripe webhook (signature verified) → flips membership to active
- `app/membership/page.tsx` — join/pay page; button calls the checkout Server Action
- `app/(protected)/members/page.tsx` — members-only page, gated on ACTIVE membership
- `components/ui/button.tsx` — shadcn Button with variants
- `lib/utils.ts` — `cn()` helper for Tailwind class merging
- `lib/db/index.ts` — Drizzle client wired to Neon serverless via `DATABASE_URL`
- `lib/db/schema.ts` — `users` table + `memberships` table (the access flag the webhook sets)
- `lib/stripe.ts` — lazy Stripe client (`getStripe()`)
- `lib/payments/checkout.ts` + `checkout-params.ts` — checkout Server Action (the SENDER)
- `lib/payments/webhook-handlers.ts` + `membership-repo.ts` — webhook logic + persistence (the RECEIVER)
- `.env.example` — env stubs for Clerk, Neon, Stripe (+ `STRIPE_PRICE_ID`, `NEXT_PUBLIC_APP_URL`)
- `tests/utils.test.ts` — Vitest unit test for `cn()`
- `tests/membership.test.ts` — functional test for the checkout + webhook slice
- `tests/e2e/homepage.spec.ts` — Playwright E2E test for the homepage

THE PAYMENT SLICE IS ALREADY WIRED END-TO-END (NON-NEGOTIABLE): a working
subscription membership flow ships in the scaffold — checkout Server Action →
Stripe Checkout → webhook `checkout.session.completed` → `memberships.status =
active` → protected `/members` route. **Customise it, do NOT rebuild it.** You
may: rename `memberships` and add domain columns (keep `clerkId` + `status` +
the stripe id columns); change copy/benefits on `/membership`; switch
`mode: 'subscription'` → `'payment'` in `checkout-params.ts` for one-time
payment. You must NOT: delete a half of the slice, hardcode a price in copy (it
lives in the Stripe Price via `STRIPE_PRICE_ID`), or grant access on the success
redirect instead of the webhook. If the brief is NOT a paid product, you may
remove the membership files — but if it takes money, keep both ends wired.

YOUR JOB:

1. **Replace placeholders** in the scaffold where the brief gives you content:
   - `app/page.tsx` h1 currently says `{{title}}` — the runner substitutes this
     to the project title verbatim. You MUST replace the surrounding marketing
     copy ("Scaffolded by KageOps from the nextjs-saas bundle.") with content
     derived from the project description.
   - NO FABRICATED FACTS: write copy ONLY from facts in the brief. Do NOT invent
     specific prices, fees, addresses, phone numbers, dates, statistics, or
     counts to make the page look finished. If the brief doesn't give a fact you
     need, leave an obvious placeholder (e.g. "[TODO: confirm pricing]") so a
     human fills it — a visible gap is recoverable; a confident fabrication ships
     as a lie.
   - `app/layout.tsx` metadata uses `{{title}}` and `{{description}}` — already
     substituted by the runner. Don't re-edit.

2. **Extend the schema** in `lib/db/schema.ts`:
   - Read the brief CAREFULLY. If the brief describes data the app stores
     (todos, posts, subscriptions, files, etc.), add Drizzle table definitions
     for each. Use the existing `users` table as the reference for column
     conventions (snake_case columns, `defaultRandom()` for IDs, `timestamp`
     with `withTimezone: true` for dates).
   - Export `type` aliases for every table (`type X = typeof xTable.$inferSelect`).
   - Keep schema in ONE file (`lib/db/schema.ts`) — don't split unless the
     brief explicitly asks for multi-domain separation.

3. **Add routes** for every brief-described feature:
   - Pages go under `app/<route>/page.tsx` — Server Components by default.
   - Route handlers (APIs) go under `app/api/<route>/route.ts`.
   - Protected pages live under `app/(protected)/` route group — the
     `middleware.ts` matcher does NOT cover this group by default, so if you
     need auth on a new route, ADD its prefix to the `isProtectedRoute` matcher
     in `middleware.ts` (e.g. `'/dashboard(.*)'` is already there — add
     `'/myroute(.*)'`).

4. **Server Actions** for mutations:
   - Mark Server Actions with `'use server'` at the top of the function body
     (or `'use server'` at the top of a `lib/actions/<area>.ts` file).
   - Server Actions import `db` from `@/lib/db` and `auth()` from `@clerk/nextjs/server`.
   - Always guard with `const { userId } = await auth(); if (!userId) throw new Error('Unauthorized');`.
   - Return plain serialisable objects from Server Actions — Next handles the
     round-trip. Don't return Date/Set/Map instances; convert to strings/arrays.

5. **Client Components** only when interactivity demands them:
   - Mark `'use client'` at the top.
   - Default to Server Components (no directive) for read-only renders.
   - Hook callers (`useState`, `useEffect`, `onClick`, `onChange`) MUST be in a
     Client Component or you'll get a Next 16 hydration error.

6. **shadcn components** — bundle ships only `<Button>`. If the brief needs
   more (input, dialog, card, dropdown), add them by editing
   `components/ui/<name>.tsx` with the canonical shadcn implementation. Do NOT
   run `npx shadcn@latest add` — that requires a network roundtrip we won't
   have in CI.

7. **Tests** — for every Server Action you add, add a Vitest unit test under
   `tests/<area>.test.ts`. For every new top-level route, add a Playwright
   smoke test under `tests/e2e/<route>.spec.ts` that asserts a `<h1>` renders.

   GENERATED TESTS MUST PASS (NON-NEGOTIABLE). `npm test` runs `vitest run` and
   the build verifier blocks the project on ANY failing test. A test suite that
   does not run green is treated as a broken feature, not a finished one. Avoid
   the failures we have actually shipped:
   - Module aliases: `@/...` is resolved by `vitest.config.ts` at collection
     time. Use `import { x } from '@/lib/...'` — NEVER `require('@/lib/...')` in
     test setup (CJS `require` bypasses the alias and throws "Cannot find
     module"). To mock a module use `vi.mock('@/lib/x', ...)` and import the
     mocked value; do not `require` it.
   - jsdom gaps (`URL.createObjectURL`, `matchMedia`, `ResizeObserver`,
     `scrollTo`) are ALREADY polyfilled in `tests/setup.ts`. Rely on it — do not
     redefine them, and do not assume other browser globals exist beyond those.
   - Assert on stable hooks: `getByRole`, `getByLabelText`, or `data-testid`.
     Do NOT use over-broad text matchers like `getByText(/member/i)` that match
     multiple nodes — they break on the next copy/restyle change.
   - `userEvent.upload(input, file)` silently DROPS files whose MIME/extension
     doesn't match the input's `accept` attribute, then the assertion fails with
     no error. Use a file whose type matches `accept`, or drive the change with
     `fireEvent.change` and an explicit `FileList`.

NON-NEGOTIABLES:

- DO NOT downgrade `package.json` deps. The version pins are deliberate.
- DO NOT introduce a new auth provider, ORM, payment processor, or UI library.
  The stack is locked: Clerk + Drizzle + Stripe + shadcn.
- DO NOT replace App Router with Pages Router or vice versa. App Router is the
  default Next 16 surface.
- DO NOT add a separate backend service. This bundle is a unified Next.js app —
  Server Actions + Route Handlers are the API surface.
- DO NOT use `'use client'` on `app/layout.tsx` or any page that doesn't need
  client interactivity — Server Components are the default for a reason.
- DO NOT commit `.env`, `.env.local`, or anything with real secrets. Only
  `.env.example` is in tree.
- TypeScript `strict: true` is on. No `any` — use `unknown` and narrow.
- Every file you write must compile under `npm run build`. Vigil's build
  verifier (P2-03) will block on TS errors.
- LAZY SDK INIT (DEPLOY-READINESS). NEVER construct an SDK client at module
  top level — no `const stripe = new Stripe(process.env.X!)`, no
  `new SomeClient(process.env.Y!)` at import scope. `next build` evaluates
  module top-level code with NO runtime secrets present (Vercel applies env at
  runtime, not build time), so an eager client construction crashes the build
  on a secret-less host. Always defer it behind a function, exactly like the
  scaffold's `lib/stripe.ts` `getStripe()`: read the env var and construct the
  client on FIRST CALL, inside the function body. Import and call `getStripe()`
  where you need Stripe; do the same pattern for any new SDK you introduce.

OUTPUT FORMAT:

For each file you edit or create, emit a FILE block:

```
FILE: app/dashboard/page.tsx
<full file content>
```

Use ONE block per file. No diffs, no patches — full file contents only. Forge's
writer is `writeFile` — it overwrites whatever exists. If you don't emit a FILE
block for a scaffold file, that file stays exactly as the scaffold has it.

Begin.
