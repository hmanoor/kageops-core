/**
 * Direct unit tests for `parseModelString`.
 *
 * The function is the entry point for every provider dispatch and is
 * exercised in every integration test, but its handling of multi-slash
 * model names (openrouter/foo/bar) and the bare-model fallback deserve
 * explicit assertions.
 */

import { describe, it, expect } from 'vitest';

import { parseModelString } from '../../../src/agents/ai-adapter/model-parser';

describe('parseModelString', () => {
    it('defaults to the claude provider when no slash is present', () => {
        const cfg = parseModelString('claude-sonnet-4-20250514');
        expect(cfg.provider).toBe('claude');
        expect(cfg.model).toBe('claude-sonnet-4-20250514');
    });

    it('splits a simple provider/model pair', () => {
        const cfg = parseModelString('openai/gpt-4o');
        expect(cfg.provider).toBe('openai');
        expect(cfg.model).toBe('gpt-4o');
    });

    it('preserves nested slashes in the model portion', () => {
        // OpenRouter routinely uses paths like `openrouter/anthropic/claude-3`.
        const cfg = parseModelString('openrouter/anthropic/claude-3');
        expect(cfg.provider).toBe('openrouter');
        expect(cfg.model).toBe('anthropic/claude-3');
    });

    it('keeps tag suffixes like ":free" intact', () => {
        const cfg = parseModelString('openrouter/meta-llama/llama-3.1-8b-instruct:free');
        expect(cfg.provider).toBe('openrouter');
        expect(cfg.model).toBe('meta-llama/llama-3.1-8b-instruct:free');
    });

    it('routes a bare "claude-cli" string to the claude-cli provider', () => {
        // The bare CLI provider names are special-cased — without this rule
        // the dispatcher silently routes to the Claude API instead of
        // claude-cli, and a user's subscription preset stops working.
        // See model-parser.ts: BARE_CLI_PROVIDERS.
        const cfg = parseModelString('claude-cli');
        expect(cfg.provider).toBe('claude-cli');
        expect(cfg.model).toBe('claude-cli');
    });

    it('routes a bare "codex-cli" string to the codex-cli provider', () => {
        // 2026-05-10 regression: codex-cli preset shipped with bare
        // `codex-cli` model strings, which previously parsed as
        // `{ provider: claude, model: codex-cli }` and routed to the
        // Anthropic API instead of the Codex CLI subprocess. Sensei's
        // truth-block then reported `provider: claude` truthfully because
        // that's what the dispatcher was actually using.
        const cfg = parseModelString('codex-cli');
        expect(cfg.provider).toBe('codex-cli');
        expect(cfg.model).toBe('codex-cli');
    });

    it('parses "claude-cli/<model>" into the claude-cli provider', () => {
        const cfg = parseModelString('claude-cli/sonnet');
        expect(cfg.provider).toBe('claude-cli');
        expect(cfg.model).toBe('sonnet');
    });

    it('parses "codex-cli/<model>" into the codex-cli provider', () => {
        const cfg = parseModelString('codex-cli/gpt-5-codex');
        expect(cfg.provider).toBe('codex-cli');
        expect(cfg.model).toBe('gpt-5-codex');
    });

    it('still defaults bare non-CLI strings to the claude provider', () => {
        // Backwards-compat: legacy code paths and MODELS.id values that omit
        // the provider prefix (e.g. "claude-sonnet-4-6") must continue
        // routing to the Claude API.
        const cfg = parseModelString('claude-sonnet-4-6');
        expect(cfg.provider).toBe('claude');
        expect(cfg.model).toBe('claude-sonnet-4-6');
    });
});
