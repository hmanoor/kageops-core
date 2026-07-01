# The KageOps Open-Core Boundary

KageOps is **open core**. This document is the honest, explicit line between what
is open source (this `kageops-core` repo, AGPL-3.0) and what is part of the
commercial **KageOps Cloud** layer (a separate private repository). We publish
this so there's no "open-washing" ambiguity: the engine is genuinely open and
genuinely runnable on its own.

## Principle

> The **engine** is open. The **hosted business** (managed cloud compute, client
> billing, team collaboration, hosted identity) is commercial. The open core has
> no dependency on the commercial layer — it runs fully standalone.

Architecturally this is enforced by a set of **seams**: the core defines an
interface with an open default and the commercial layer injects its
implementation at a boundary. The open build ships the no-op default. There are
**zero `open → commercial` imports** in this repo (verified by an import-graph
check in CI).

## What's open (this repo)

| Area | Status |
|------|--------|
| Sensei orchestrator, the 8 Autonauts, agent framework | ✅ Open |
| Task decomposition, routing, phase gates | ✅ Open |
| BuildVerificationGate + AcceptanceGate (+ retry/repair) | ✅ Open |
| Multi-provider AI adapter (Claude/OpenRouter/Ollama/OpenAI/Gemini) | ✅ Open |
| Embedded PGlite DB, event bus, schema | ✅ Open |
| Headless CLI runner (`--dry-run`, budget caps) | ✅ Open |
| Command Center desktop UI | ✅ Open (cloud/team/billing panels feature-flagged, no-op without the commercial layer) |
| Cost guardrails, APO (prompt optimization) | ✅ Open |
| `KageOpsConnector` interface (`connectors/types.ts`) | ✅ Open |

## What's commercial (separate private repo)

| Area | Why |
|------|-----|
| Azure **Cloud Burst** (run agents on cloud compute) | The hosted-compute business |
| Managed **deploy** (provision + deploy client apps) + Azure environments | Hosted operations |
| **Team collaboration** (roles, seats, shared Sensei, presence) | Paid team tier |
| **Billing** (Stripe plans, webhooks, plan gating) | Monetization |
| Hosted **auth** (Clerk device-flow, SSO) + plan windows | Hosted identity |
| **Setup copilot** + app-credential provisioning | Hosted onboarding |
| Outbound **connectors** (Slack / Discord / Teams implementations) | Only the interface is open |

## How the seams work

Each commercial capability is reached through a small interface in the core:

- `PlanGate` → open default `openPlanGate` (grants everything)
- `PostDeployHook` → open default `noopPostDeployHook`
- `SetupCopilotGate` → open default `noopSetupCopilotGate`
- `CommercialExtensions` (main-process) → open default `{}`
- `BootstrapExtensions` (orchestrator) → open default `{}`

The commercial layer provides the real implementations; the open build ships the
defaults. Entry files (`main.ts`, `orchestrator-bootstrap.ts`, `run-agent.ts`)
are identical in both repos — only the injected implementation differs.

## Licensing

The open core is **AGPL-3.0** (see [LICENSE](LICENSE)). If the AGPL's copyleft
doesn't fit your use, a commercial license is available — contributions are
accepted under our [CLA](CLA.md) to preserve that dual-licensing option. The
commercial cloud layer is proprietary and not covered by this repository.

*This boundary can evolve. Material changes will be noted in the
[CHANGELOG](CHANGELOG.md).*
