/**
 * Tests for src/learning/prompt-mutator.ts
 *
 * Covers:
 *  - sendPrompt receives the right model, system, and user strings
 *  - critique is embedded in the user prompt
 *  - trimming + empty-response handling
 *  - oversize-retry path (1 extra attempt, then throw)
 */

import { describe, it, expect, vi } from 'vitest';

import {
    MUTATE_MAX_CHARS,
    mutatePrompt,
    type MutatorAiResponse,
    type SendPromptFn,
} from '../../src/learning/prompt-mutator';

// ── Helpers ──────────────────────────────────────────

function makeSend(responses: readonly string[] | readonly MutatorAiResponse[]): SendPromptFn & { readonly mock: ReturnType<typeof vi.fn> } {
    const normalized: readonly MutatorAiResponse[] = responses.map((r) =>
        typeof r === 'string' ? { text: r } : r
    );
    let i = 0;
    const fn = vi.fn(async (_model: string, _sys: string, _user: string) => {
        const res = normalized[Math.min(i, normalized.length - 1)];
        i += 1;
        return res;
    }) as unknown as SendPromptFn & { readonly mock: ReturnType<typeof vi.fn> };
    return fn;
}

const BASE_PROMPT = 'You are Scout. Respond with JSON {"insight": string}.';
const CRITIQUE = "Scout's responses were too verbose and expensive";

// ── Tests ────────────────────────────────────────────

describe('mutatePrompt()', () => {
    it('calls sendPrompt exactly once on the happy path', async () => {
        const send = makeSend(['  NEW PROMPT  ']);
        const out = await mutatePrompt(BASE_PROMPT, CRITIQUE, send);

        expect(send).toHaveBeenCalledTimes(1);
        expect(out).toBe('NEW PROMPT'); // trimmed
    });

    it('passes model + system + user prompts in the documented shape', async () => {
        const send = makeSend(['rewritten']);
        await mutatePrompt(BASE_PROMPT, CRITIQUE, send);

        const call = (send as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
            string,
            string,
            string,
            unknown,
        ];
        const [model, systemPrompt, userPrompt, options] = call;

        expect(typeof model).toBe('string');
        expect(model.length).toBeGreaterThan(0);
        // System prompt must mention persona + JSON schema preservation.
        expect(systemPrompt).toMatch(/persona/i);
        expect(systemPrompt).toMatch(/JSON/i);
        // User prompt carries the exact critique verbatim + the baseline.
        expect(userPrompt).toContain(CRITIQUE);
        expect(userPrompt).toContain(BASE_PROMPT);
        expect(userPrompt).toMatch(/Return only the new prompt/i);
        // Options carry sensible defaults.
        expect(options).toMatchObject({ maxTokens: expect.any(Number) });
    });

    it('throws on empty baseline prompt (no LLM call)', async () => {
        const send = makeSend(['x']);
        await expect(mutatePrompt('   ', CRITIQUE, send)).rejects.toThrow(/basePrompt/);
        expect(send).not.toHaveBeenCalled();
    });

    it('throws on empty critique (no LLM call)', async () => {
        const send = makeSend(['x']);
        await expect(mutatePrompt(BASE_PROMPT, '', send)).rejects.toThrow(/critique/);
        expect(send).not.toHaveBeenCalled();
    });

    it('throws when the model returns an empty string', async () => {
        const send = makeSend(['   ']);
        await expect(mutatePrompt(BASE_PROMPT, CRITIQUE, send)).rejects.toThrow(/empty/);
    });

    it('retries once when output exceeds MUTATE_MAX_CHARS, then succeeds', async () => {
        const huge = 'A'.repeat(MUTATE_MAX_CHARS + 50);
        const ok = 'compact prompt';
        const send = makeSend([huge, ok]);

        const out = await mutatePrompt(BASE_PROMPT, CRITIQUE, send);
        expect(send).toHaveBeenCalledTimes(2);
        expect(out).toBe(ok);

        // Retry call must include an explicit length instruction.
        const calls = (send as unknown as { mock: { calls: unknown[][] } }).mock.calls;
        const retryUserPrompt = calls[1][2] as string;
        expect(retryUserPrompt).toMatch(new RegExp(String(MUTATE_MAX_CHARS)));
    });

    it('throws when the retry is still oversize', async () => {
        const huge = 'A'.repeat(MUTATE_MAX_CHARS + 1);
        const stillHuge = 'B'.repeat(MUTATE_MAX_CHARS + 2);
        const send = makeSend([huge, stillHuge]);

        await expect(mutatePrompt(BASE_PROMPT, CRITIQUE, send)).rejects.toThrow(/exceeds/);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('propagates errors from sendPrompt', async () => {
        const send = vi.fn(async () => {
            throw new Error('boom');
        }) as unknown as SendPromptFn;
        await expect(mutatePrompt(BASE_PROMPT, CRITIQUE, send)).rejects.toThrow(/boom/);
    });
});
