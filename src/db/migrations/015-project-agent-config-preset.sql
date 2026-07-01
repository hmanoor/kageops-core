-- Migration 015: per-project agent_config_preset
--
-- Setup wizard plan, decision Q5 (2026-05-03):
--   Each project carries an optional preset name that overrides the global
--   default for ALL its agents. NULL means "inherit the global default at
--   runtime" (set via the first-run wizard or Settings → Default preset).
--
--   The preset name resolves to a `~/.kageops/agent-config.<preset>.json`
--   file. Power users can drop custom preset files there for advanced mixes
--   without needing per-agent UI overrides at the project level.
--
--   Concurrent projects with different presets work natively because every
--   askAI() call is project-scoped: it looks up `task.project_id` →
--   `project.agent_config_preset` → loads that preset's config from disk per
--   call. No shared mutable agent state, no race condition.
--
-- Idempotent — safe to re-run.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_config_preset TEXT;
