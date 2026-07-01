# Contributing to KageOps Core

Thanks for your interest in improving KageOps! This guide covers everything you
need to land a change.

## TL;DR

1. Sign the [CLA](CLA.md) (one-time — a bot will prompt you on your first PR).
2. Fork, branch, and make your change with tests.
3. `npm run build && npm test` must pass; keep `tsc --strict` clean.
4. Use [Conventional Commits](#commit-messages).
5. Open a PR against `main` with a clear description and test plan.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Dev setup

Requires **Node 20+**. No Docker or external database needed — KageOps boots an
embedded Postgres (PGlite) in-process.

```bash
git clone https://github.com/<you>/kageops-core.git
cd kageops-core
npm install
npm run build        # tsc + esbuild
npm test             # vitest — the full suite must pass
npx tsc --noEmit     # type-check only
```

Preview the engine end-to-end without spending anything:

```bash
npx tsx src/cli/headless-runner.ts --dry-run --name "Demo" --description "..."
```

## What to work on

- **Good first issues** are labelled [`good first issue`](https://github.com/hmanoor/kageops-core/labels/good%20first%20issue).
- Bug fixes, provider adapters, agent-prompt improvements, docs, and tests are
  always welcome.
- For a **large or architectural** change, please open an issue to discuss it
  first — it saves everyone a wasted PR.
- Note the [open-core boundary](OPEN-CORE.md): features belonging to the
  commercial cloud layer (managed deploy, billing, team, hosted auth,
  connectors) are out of scope for this repo. When in doubt, ask in an issue.

## Coding standards

- **TypeScript strict.** No `any` — use `unknown` and narrow. Explicit return
  types on exported functions. `readonly` on interface fields.
- **Immutability.** Return new objects; never mutate inputs. Spread to update.
- **Small, focused files** (~200–400 lines typical, 800 hard max). One concern
  per file.
- **Handle every error.** No empty catches; log with a `[Module]` prefix.
- **Parameterized SQL only.** Never string-concatenate queries.
- Match the style of the surrounding code.

## Tests

- New features and bug fixes **must** ship with tests (unit + integration where
  it makes sense). We hold a high coverage bar.
- Put tests under `tests/` mirroring the `src/` path.
- Run the full suite locally before pushing: `npm test`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional body — the why, not just the what>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull requests

- Branch off `main`; keep PRs focused (one logical change).
- Fill in the description: **what**, **why**, and a **test plan**.
- CI must be green: **Build · Test · Lint · Secret scan**.
- A maintainer will review. Address CRITICAL/HIGH feedback before merge.
- We use squash-merge with a linear history.

## Contributor License Agreement (CLA)

KageOps Core is AGPL-3.0. To keep the option of offering KageOps under a
commercial license alongside the open core, we ask contributors to sign a
lightweight [CLA](CLA.md) granting us the rights to your contribution. It's a
one-time click, automated on your first PR. You retain copyright to your work.

## Questions

Open a [Discussion](https://github.com/hmanoor/kageops-core/discussions) or an
issue. This is a community project with **no support SLA** — we help when we can.
