# Changelog

All notable changes to KageOps Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- First public release of the KageOps engine (open core, AGPL-3.0).
- Sensei orchestrator + 8 Autonauts (Scout, Blueprint, Pixel, Forge, Cipher,
  Aegis, Vigil, Herald) and the agent framework.
- 6-phase product lifecycle with phase gates; BuildVerificationGate +
  AcceptanceGate with tiered retry-and-repair.
- Multi-provider AI adapter (Claude, OpenRouter, Ollama, OpenAI, Gemini) with
  cost guardrails and budget-kill.
- Embedded PGlite database (zero-Docker), Postgres LISTEN/NOTIFY event bus.
- Headless CLI runner with `--dry-run` and per-run budget caps.
- Command Center desktop UI (cloud/team/billing panels feature-flagged).
- Automatic Prompt Optimization (APO), opt-in and propose-only.
- Open-core seams (`PlanGate`, `PostDeployHook`, `SetupCopilotGate`,
  `CommercialExtensions`, `BootstrapExtensions`) with open no-op defaults, so the
  engine runs standalone with zero commercial dependencies.

<!--
Release-tag convention (fill in at first public cut):

## [0.1.0] - YYYY-MM-DD
[Unreleased]: https://github.com/hmanoor/kageops-core/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hmanoor/kageops-core/releases/tag/v0.1.0
-->
