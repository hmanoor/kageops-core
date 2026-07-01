# `bundles/` — KageOps Project-Type Bundles

> **Pillar 1.3 (Devin-parity roadmap) — schema landed in [P1-10](../docs/plans/p1-03-skills-framework-plan.md).**

A **bundle** is a self-contained, declarative package describing how KageOps builds a particular kind of thing. Adding a new project type — Next.js SaaS, FastAPI service, Chrome extension — means adding a bundle directory here, not editing Forge/Blueprint/orchestrator source.

## Structure

```
bundles/
├── stacks/              # what the project IS (vanilla-html, nextjs-saas, fastapi, ...)
├── capabilities/        # what the project DOES (auth, payments, ...)  — populated in Pillar 2+
└── deployers/           # how the project SHIPS (vercel, cloudflare, ...) — populated in Pillar 2+
```

Each bundle is a directory with a `bundle.yaml` manifest at its root, plus scaffold files, prompt fragments, and (optionally) bundle-specific Vigil checks.

## Schema

See [`src/bundles/types.ts`](../src/bundles/types.ts) for the canonical TypeScript shape and [`src/bundles/bundle-loader.ts`](../src/bundles/bundle-loader.ts) for the loader + validation.

Minimal bundle.yaml:

```yaml
schemaVersion: 1
name: my-stack
kind: stack
version: "1.0.0"
description: |
  What this bundle does in one paragraph.
match:
  phrases: ["keyword 1", "keyword 2"]
  tags: [tag1, tag2]
```

## Naming vs `src/skills/`

`src/skills/` is the OpenSpace-inspired **agent-learning DB** (markdown + embeddings, runtime-captured patterns). It is unrelated to this directory. Bundles live on disk, get loaded at process boot, and shape project scaffolding. Skills live in Postgres, get captured at runtime, and shape agent prompts.

## Naming the manifest

We use **`bundle.yaml`** (not `skill.yaml` as in the original roadmap text) to keep the two concepts cleanly separated. The plan PR that resolved this is in [`docs/plans/p1-03-skills-framework-plan.md`](../docs/plans/p1-03-skills-framework-plan.md).

## What lands in which PR

| PR | What |
|---|---|
| **P1-10** *(this PR)* | Schema + loader + registry. No bundles populated yet. Empty `stacks/` etc. directories reserved. |
| **P1-11** | First real bundle: `stacks/vanilla-html/` — extracted from `src/agents/specialists/forge.ts:1070-1300` + 6 other files. |
| **P1-12** | Scout learns to match project intent against bundle `match.phrases` / `match.tags`. |
| **P1-13** | Bundle versioning + `kageops_version` semver compatibility check at load time. |
| **P1-14** | End-to-end smoke proving extraction is behaviourally equivalent. Closes Pillar 1.3. |
