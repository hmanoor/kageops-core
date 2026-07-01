/**
 * Public text utilities — stripping reasoning-model thinking tags and
 * classifying upstream HTTP errors into broad categories used by the
 * retry loop and cost-tracking layer.
 */

import type { HttpErrorClass } from './types';

/**
 * Strip <think>...</think> blocks that reasoning models (qwen3, deepseek-r1,
 * etc.) emit before their actual answer. Callers that need to parse JSON
 * must call this first.
 */
export function stripThinkingTags(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Classify an HTTP error by status code and body content.
 */
export function classifyHttpError(statusCode: number, body?: string): HttpErrorClass {
    if (statusCode === 429) return 'rate-limit';
    if (statusCode === 408) return 'timeout';
    if (statusCode === 401 || statusCode === 403) return 'auth-error';
    if (statusCode >= 500) return 'server-error';

    if (body !== undefined) {
        const lower = body.toLowerCase();
        if (lower.includes('rate_limit') || lower.includes('rate limit')) return 'rate-limit';
    }

    return 'client-error';
}
