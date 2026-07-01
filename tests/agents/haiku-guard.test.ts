/**
 * Haiku heavy-prompt guard — escalate-not-fail.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveHaikuGuard,
    resolveHaikuEscalationTarget,
    HAIKU_GUARD_ENV,
    HAIKU_LIMIT_ENV,
    HAIKU_ESCALATION_ENV,
} from '../../src/agents/haiku-guard';

const HAIKU = 'claude-cli/haiku';
const SONNET = 'claude-cli/claude-sonnet-4-6';

describe('resolveHaikuGuard', () => {
    it('allows non-Haiku models regardless of size', () => {
        expect(resolveHaikuGuard(SONNET, [], 500_000, {})).toEqual({ action: 'allow' });
    });

    it('allows Haiku prompts within the limit', () => {
        expect(resolveHaikuGuard(HAIKU, [], 9_999, {})).toEqual({ action: 'allow' });
    });

    it('escalates an over-limit Haiku prompt to a same-provider Sonnet by default', () => {
        const d = resolveHaikuGuard(HAIKU, [], 83_000, {});
        expect(d.action).toBe('escalate');
        expect(d.model).toBe(SONNET);
    });

    it('prefers a configured non-Haiku fallback over the provider default', () => {
        const d = resolveHaikuGuard(HAIKU, ['claude-cli/haiku', 'openrouter/anthropic/claude-sonnet-4'], 83_000, {});
        expect(d).toEqual({ action: 'escalate', model: 'openrouter/anthropic/claude-sonnet-4' });
    });

    it('honours an explicit escalation override', () => {
        const d = resolveHaikuGuard(HAIKU, [], 83_000, { [HAIKU_ESCALATION_ENV]: 'claude-cli/whatever' });
        expect(d).toEqual({ action: 'escalate', model: 'claude-cli/whatever' });
    });

    it('blocks (old behavior) when KAGEOPS_HAIKU_GUARD=block', () => {
        const d = resolveHaikuGuard(HAIKU, [], 83_000, { [HAIKU_GUARD_ENV]: 'block' });
        expect(d.action).toBe('block');
        expect(d.reason).toContain('exceeds 10k limit');
        expect(d.reason).toContain(HAIKU);
    });

    it('blocks when no escalation target can be resolved (unknown provider, no fallback)', () => {
        const d = resolveHaikuGuard('ollama/some-haiku-thing', [], 83_000, {});
        expect(d.action).toBe('block');
    });

    it('respects a custom token limit', () => {
        expect(resolveHaikuGuard(HAIKU, [], 5_000, { [HAIKU_LIMIT_ENV]: '4000' }).action).toBe('escalate');
        expect(resolveHaikuGuard(HAIKU, [], 5_000, { [HAIKU_LIMIT_ENV]: '6000' }).action).toBe('allow');
    });

    it('falls back to the default limit on a garbage override', () => {
        expect(resolveHaikuGuard(HAIKU, [], 9_000, { [HAIKU_LIMIT_ENV]: 'banana' }).action).toBe('allow');
        expect(resolveHaikuGuard(HAIKU, [], 11_000, { [HAIKU_LIMIT_ENV]: 'banana' }).action).toBe('escalate');
    });
});

describe('resolveHaikuEscalationTarget', () => {
    it('override > non-Haiku fallback > provider default', () => {
        expect(resolveHaikuEscalationTarget(HAIKU, ['x/sonnet'], { [HAIKU_ESCALATION_ENV]: 'forced/model' })).toBe('forced/model');
        expect(resolveHaikuEscalationTarget(HAIKU, ['claude-cli/haiku', 'x/sonnet'], {})).toBe('x/sonnet');
        expect(resolveHaikuEscalationTarget(HAIKU, [], {})).toBe(SONNET);
    });

    it('returns null for a provider with no default and no fallback', () => {
        expect(resolveHaikuEscalationTarget('codex-cli/haiku-ish', [], {})).toBeNull();
    });
});
