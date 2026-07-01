# {{title}}

A Next.js 16 SaaS application scaffolded by KageOps from the `nextjs-saas` bundle.

## Stack

- **Framework:** Next.js 16 (App Router + Server Components)
- **Auth:** Clerk
- **Database:** Neon Postgres via Drizzle ORM
- **Payments:** Stripe
- **UI:** shadcn/ui on Tailwind CSS
- **Testing:** Vitest (unit) + Playwright (E2E)
- **Deploy:** Vercel (`vercel deploy --prebuilt`)

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Clerk + Neon + Stripe keys
npm run db:push              # push the initial schema to your Neon database
npm run dev                  # http://localhost:3000
```

## Common commands

```bash
npm run build       # production build
npm run test        # vitest unit tests
npm run test:e2e    # playwright e2e tests
npm run lint        # next lint
npm run db:generate # drizzle-kit generate migrations
```

## Project layout

```
app/                # App Router pages, layouts, route handlers
  (auth)/           # Clerk sign-in / sign-up routes
  api/              # Route handlers (Stripe webhook lives here)
components/ui/      # shadcn/ui components
lib/
  db/               # Drizzle client + schema
  utils.ts          # shadcn cn() helper
middleware.ts       # Clerk middleware
tests/
  *.test.ts(x)      # Vitest unit tests
  e2e/              # Playwright E2E tests
```

## Deploy to Vercel

The bundle ships with the matching `bundles/deployers/vercel` deployer (lands
in P2-04). Aegis runs `vercel deploy --prebuilt` against the operator's
personal Vercel scope; preview URLs are returned to the Command Center.
Production promotion is manual (operator clicks "Promote to Production" in the
Vercel dashboard) — KageOps never ships to prod automatically.
