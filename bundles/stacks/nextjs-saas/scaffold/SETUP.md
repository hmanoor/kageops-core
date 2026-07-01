# Deploying {{title}}

A step-by-step runbook to take this app from the generated source to a live URL.
Stack: **Next.js 16 (App Router) · Clerk (auth) · Neon Postgres + Drizzle · Stripe · Vercel.**

> Read `AGENTS.md` first if you are an automated agent — it lists the
> non-negotiable gotchas. This file is the ordered human/agent procedure.

## End-to-end order

```
Neon DB → env vars → drizzle migrations → Vercel deploy
→ Clerk production domain → Stripe webhook (deployed URL) → smoke test
```

You can't register the Stripe webhook or finalise Clerk's production domain until
you have the deployed URL — so deploy first, then circle back for those two.

## 1. Database — Neon

1. Create a Neon project (https://console.neon.tech) — the free tier (0.5 GB) is
   plenty for a first deploy. Or add it from the Vercel Marketplace so the env
   var is wired automatically.
2. Copy the **pooled** connection string into `DATABASE_URL`:
   ```
   DATABASE_URL=postgres://<user>:<pw>@<host>.neon.tech/<db>?sslmode=require
   ```
3. Apply the schema. A correct **baseline migration already ships** at
   `drizzle/0000_init.sql` (`users` + `memberships`, Clerk-keyed, no passwords):
   ```bash
   npm run db:migrate    # applies committed migrations in order to DATABASE_URL
   # — or, for an early dev DB you don't mind force-syncing:
   npm run db:push       # diffs lib/db/schema.ts straight onto DATABASE_URL
   ```
   When you add tables, edit `lib/db/schema.ts` then `npm run db:generate` — it
   writes the NEXT migration (`0001_…`) into `./drizzle`; commit it. Migrations
   are committed and must apply top-to-bottom on a fresh DB — every type/enum/
   table declared before first use. Never hand-write raw SQL or recreate `0000`.
   Do NOT seed `password_hash` or hardcoded user rows: auth is delegated to
   Clerk, so users come from Clerk and app tables FK to the Clerk user id.

## 2. Auth — Clerk

1. Create a Clerk application (https://dashboard.clerk.com).
2. Copy the keys (API Keys):
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — `pk_test_…` in dev, safe to expose.
   - `CLERK_SECRET_KEY` — `sk_test_…`, server-only. Never commit it.
3. Dev (`pk_test_`) keys work on any origin. For a production instance
   (`pk_live_`), add the deployed domain under **Clerk → Domains** after step 4.

## 3. Payments — Stripe (test mode)

Use **test** keys end to end: `sk_test_…` (server) + `pk_test_…` (publishable) →
`STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. The webhook secret
is wired in step 5 (you need the deployed URL first).

This app's webhook route is **`/api/stripe/webhook`** (`app/api/stripe/webhook/route.ts`).
The webhook is the authoritative payment signal — never grant access on the
success redirect (it's spoofable). A checkout feature needs BOTH ends: a Server
Action that calls `getStripe().checkout.sessions.create(...)` AND the webhook
`case 'checkout.session.completed'` that flips the row to active.

## 4. Deploy — Vercel

```bash
npm i -g vercel
vercel link                                  # link to a new/existing project
vercel env add DATABASE_URL production       # repeat for EVERY var below
vercel deploy --prod
```

Push every var to the **Production** scope: `DATABASE_URL`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and (after step 5) `STRIPE_WEBHOOK_SECRET`.
Set `VERCEL_TOKEN` (Account → Tokens) for non-interactive deploys. Vercel bakes
env at build time — **redeploy after changing any var**.

> **Hobby `BLOCKED` trap.** On a free Hobby team a deploy can return `BLOCKED` —
> the CLI shows it as `UNKNOWN` with no build logs, which looks like a build
> failure but is a usage/deploy-limit block. Confirm with
> `curl https://api.vercel.com/v13/deployments/<url> -H "Authorization: Bearer $VERCEL_TOKEN"`
> and look for `"readyState": "BLOCKED"`. It resets daily / clears on Pro.

**For a hand-over the client will own, prefer the GitHub integration**
(Vercel dashboard → Add New → Project → Import Git Repository). It builds through
the git pipeline (sidesteps the Hobby CLI block) and the client redeploys by
`git push`. The CLI is fine for your own throwaway previews.

## 5. After deploy — circle back

1. **Stripe webhook** — register it against the deployed URL via the API (your
   `sk_test_` key authenticates; no dashboard clicking):
   ```bash
   curl https://api.stripe.com/v1/webhook_endpoints -u "$STRIPE_SECRET_KEY:" \
     -d url="https://<app>.vercel.app/api/stripe/webhook" \
     -d "enabled_events[]=checkout.session.completed"
   ```
   The signing secret (`whsec_…`) is returned **once** in that response — capture
   it immediately into `STRIPE_WEBHOOK_SECRET` (Vercel + local). You can't read it
   back; you'd have to roll a new one.
2. **Clerk domain** — if using production (`pk_live_`) keys, add the deployed
   domain under Clerk → Domains.
3. **Redeploy** so the new `STRIPE_WEBHOOK_SECRET` is baked in.

## 6. Smoke test the full slice

1. Deployed URL → sign up / sign in (Clerk).
2. Start checkout → Stripe Checkout opens.
3. Pay with the test card `4242 4242 4242 4242`, any future expiry, any CVC.
4. The **webhook** (not the redirect) flips the row to active — verify in the DB,
   not just the UI.

## Local development

```bash
cp .env.example .env.local   # fill in the same vars
npm install
npm run db:push              # apply schema to your dev DATABASE_URL
npm run dev
# Stripe webhooks locally:
stripe listen --forward-to localhost:3000/api/stripe/webhook
```
