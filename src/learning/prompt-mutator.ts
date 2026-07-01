/**
 * KageOps Learning — Prompt Mutator (Phase 4, APO iter 1)
 *
 * LLM-driven system-prompt rewriter. Given a baseline prompt and a terse
 * one-sentence critique, asks an LLM to produce a rewrite that addresses
 * the critique while preserving the agent's persona and JSON schemas.
 *
 * The LLM call is injected as a `sendPrompt` function so tests can mock it
 * deterministically. In production, wire `ai-adapter.sendPrompt` so cost
 * tracking and per-task budget caps apply — APO must live within the same
 * guardrails as any other agent LLM call (CLAUDE.md — Cost Guardrails).
 */

import { createLogger } from '../shared/logger';

const log = createLogger('APO');

// ── Constants ────────────────────────────────────────

/** Hard cap on mutated prompt length. If the LLM exceeds, we retry once. */
export const MUTATE_MAX_CHARS = 4000;

/** Model string used by the default mutator. Configurable via env. */
const MUTATOR_MODEL =
    process.env['KAGEOPS_APO_MUTATOR_MODEL'] ?? 'claude/claude-haiku-3-5-20241022';

const MUTATOR_SYSTEM_PROMPT =
    "You rewrite agent system prompts. Keep the same persona, " +
    "tone, and JSON schemas. Return only the new prompt, no preamble, " +
    "no commentary, no markdown fences.";

// ── Types ────────────────────────────────────────────

/** Subset of `ai-adapter.AiResponse` actually required by the mutator. */
export interface MutatorAiResponse {
    readonly text: string;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
    readonly costUsd?: number;
    readonly model?: string;
    readonly durationMs?: number;
}

/**
 * Shape compatible with `ai-adapter.sendPrompt`.
 * We accept a loose structural type so tests can hand us a tiny fake.
 */
export type SendPromptFn = (
    modelString: string,
    systemPrompt: string,
    userPrompt: string,
    options?: { readonly maxTokens?: number; readonly temperature?: number }
) => Promise<MutatorAiResponse>;

// ── API ──────────────────────────────────────────────

/**
 * Rewrite `basePrompt` to address `critique`.
 *
 * Behaviour:
 *  - Sends a terse user-prompt: "Rewrite this agent system prompt to address: {critique}.
 *    Keep the same persona and JSON schemas. Return only the new prompt."
 *  - If the returned text exceeds `MUTATE_MAX_CHARS`, retries ONCE with an
 *    explicit length instruction appended. If it still exceeds, throws.
 *  - Strips surrounding whitespace. Empty responses throw.
 */
export async function mutatePrompt(
    basePrompt: string,
    critique: string,
    sendPrompt: SendPromptFn
): Promise<string> {
    if (basePrompt.trim() === '') {
        throw new Error('[APO] mutatePrompt: basePrompt is empty.');
    }
    if (critique.trim() === '') {
        throw new Error('[APO] mutatePrompt: critique is empty.');
    }

    const userPrompt = buildUserPrompt(basePrompt, critique, false);
    let response: MutatorAiResponse;
    try {
        response = await sendPrompt(MUTATOR_MODEL, MUTATOR_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 2048,
            temperature: 0.7,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, 'mutatePrompt: first attempt threw');
        throw err;
    }

    let candidate = (response.text ?? '').trim();

    if (candidate === '') {
        throw new Error('[APO] mutatePrompt: model returned empty output.');
    }

    if (candidate.length <= MUTATE_MAX_CHARS) {
        return candidate;
    }

    // Oversize — retry once with an explicit length instruction.
    log.warn(
        { length: candidate.length, cap: MUTATE_MAX_CHARS },
        'mutatePrompt: first output oversize, retrying with length hint'
    );

    const retryUserPrompt = buildUserPrompt(basePrompt, critique, true);
    const retry = await sendPrompt(MUTATOR_MODEL, MUTATOR_SYSTEM_PROMPT, retryUserPrompt, {
        maxTokens: 2048,
        temperature: 0.5,
    });
    candidate = (retry.text ?? '').trim();

    if (candidate === '') {
        throw new Error('[APO] mutatePrompt: retry returned empty output.');
    }
    if (candidate.length > MUTATE_MAX_CHARS) {
        throw new Error(
            `[APO] mutatePrompt: retry still exceeds ${MUTATE_MAX_CHARS} chars (${candidate.length}).`
        );
    }
    return candidate;
}

// ── Internals ────────────────────────────────────────

function buildUserPrompt(
    basePrompt: string,
    critique: string,
    emphasizeLength: boolean
): string {
    const lengthHint = emphasizeLength
        ? ` The new prompt MUST be strictly under ${MUTATE_MAX_CHARS} characters.`
        : '';
    return (
        `Rewrite this agent system prompt to address: ${critique}. ` +
        `Keep the same persona and JSON schemas. Return only the new prompt.` +
        lengthHint +
        `\n\n---\n` +
        basePrompt
    );
}
