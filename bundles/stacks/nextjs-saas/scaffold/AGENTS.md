# AGENTS.md — {{title}}

Guidance for an AI agent (or developer) picking up this repo. The full deploy
procedure is in **`SETUP.md`** — read it before deploying. This file is the
short list of things that will bite you if you ignore them.

## Stack (locked)

Next.js 16 App Router · Clerk (auth) · Neon Postgres + Drizzle ORM · Stripe
(payments) · shadcn/ui · Vitest + Playwright · deploys to Vercel. Do not swap
the auth provider, ORM, payment processor, or UI library.

## Non-negotiable gotchas

- **No SDK client at module load.** Never `new Stripe(process.env.X!)` or build a
  DB client at import scope — `next build` evaluates module top-level code with
  NO secrets present and crashes on a secret-less host. Construct lazily:
  `lib/stripe.ts` `getStripe()` and `lib/db` `getDb()` already do this. Follow
  the same pattern for any new SDK.
- **The webhook is the authoritative payment signal.** Grant access only when
  `checkout.session.completed` fires on `/api/stripe/webhook` — never on the
  success-page redirect (it's spoofable). A checkout feature needs BOTH ends: a
  Server Action that creates the session AND the webhook case that consumes it.
- **`STRIPE_WEBHOOK_SECRET` (`whsec_…`) is shown once** when you register the
  webhook — capture it immediately (see SETUP.md step 5).
- **A correct baseline migration already ships** at `drizzle/0000_init.sql`
  (`users` + `memberships`, both keyed on the Clerk user id, no passwords). It is
  COMMITTED and applies clean on a fresh DB. To add tables: edit
  `lib/db/schema.ts`, then run `npm run db:generate` — drizzle diffs the snapshot
  and writes the NEXT migration (`0001_…`); commit it. **Never hand-write raw
  `CREATE TABLE` SQL and never recreate `0000`** — that path produced a broken,
  un-appliable migration (a stray `password` column) in past runs. Extend the
  baseline; don't reinvent it.
- **Migrations must apply on a fresh DB in order** — declare every type/enum/
  table before first use. Do NOT seed passwords or hardcoded users: auth is
  delegated to Clerk; app tables FK to the Clerk user id.
- **No fabricated facts in copy or seed data.** Prices, addresses, dates, counts,
  contact details must come from the brief. If a fact is missing, leave a visible
  `[TODO: ...]` placeholder — never invent a plausible value.
- **No bash env-prefix in `package.json` scripts** (`VAR=1 next build`) — breaks
  on Windows. Use `cross-env` or drop it.
- **Hobby `BLOCKED` ≠ build failure.** A Vercel Hobby deploy can come back
  `UNKNOWN`/`BLOCKED` with no logs — that's a usage-limit block, not a broken
  build. See SETUP.md.

## Tests

`npm test` runs `vitest run` and must be green before the app is "done". jsdom
polyfills live in `tests/setup.ts`; import aliased modules with `@/…`, never
`require("@/…")` in test setup.
