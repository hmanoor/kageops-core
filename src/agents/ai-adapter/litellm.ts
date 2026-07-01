/**
 * LiteLLM proxy routing (opt-in).
 *
 * When LITELLM_PROXY_URL is set, ALL AI calls are routed through a local
 * LiteLLM proxy. LiteLLM exposes an OpenAI-compatible /chat/completions
 * endpoint and forwards to the correct upstream provider based on the
 * `model` field. Spend data is captured in Postgres automatically.
 */

import { calculateCost } from './cost';
import { httpRequest } from './http';
import { parseModelString } from './model-parser';
import { sendOpenAiStyleStreaming } from './openai';
import type { AiRequestOptions, AiResponse, ConversationMessage } from './types';

export const LITELLM_PROXY_URL: string | null = process.env['LITELLM_PROXY_URL'] ?? null;
export const LITELLM_MASTER_KEY: string = process.env['LITELLM_MASTER_KEY'] ?? 'kageops-dev-key';

export async function sendViaLiteLLM(
    modelString: string,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions
): Promise<AiResponse> {
    const proxyUrl = new URL('/chat/completions', LITELLM_PROXY_URL!);
    const start = Date.now();

    const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LITELLM_MASTER_KEY}`,
    };

    const requestBody = {
        model: modelString,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        ...(options.onStream !== undefined ? { stream: true } : {}),
    };

    const body = JSON.stringify(requestBody);

    const requestOpts = {
        hostname: proxyUrl.hostname,
        port: parseInt(proxyUrl.port, 10) || 4000,
        path: proxyUrl.pathname,
        method: 'POST',
        headers: requestHeaders,
        protocol: proxyUrl.protocol,
    };

    let result: AiResponse;

    if (options.onStream !== undefined) {
        // LiteLLM is OpenAI-compatible — reuse the shared streaming handler.
        // Forward protocol + port so http:// proxies (e.g. LITELLM_PROXY_URL=
        // http://localhost:4000) don't get silently upgraded to https.
        result = await sendOpenAiStyleStreaming(
            { provider: 'openai', model: modelString },
            requestOpts.hostname,
            requestOpts.path,
            requestHeaders,
            body,
            options.onStream,
            requestOpts.protocol,
            requestOpts.port
        );
    } else {
        const response = await httpRequest(requestOpts, body);
        const data = JSON.parse(response) as Record<string, unknown>;
        const choices = data.choices as Array<{ message: { content: string } }> | undefined;
        const text = choices?.[0]?.message?.content ?? '';
        const usage = data.usage as { prompt_tokens: number; completion_tokens: number } | undefined;

        const config = parseModelString(modelString);
        result = {
            text,
            tokensIn: usage?.prompt_tokens ?? 0,
            tokensOut: usage?.completion_tokens ?? 0,
            costUsd: calculateCost(config.model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
            model: modelString,
            durationMs: 0,
        };
    }

    return { ...result, durationMs: Date.now() - start };
}

export async function sendViaLiteLLMConversation(
    modelString: string,
    systemPrompt: string,
    messages: readonly ConversationMessage[],
    options: AiRequestOptions
): Promise<AiResponse> {
    const allMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const proxyUrl = new URL('/chat/completions', LITELLM_PROXY_URL!);
    const start = Date.now();

    const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LITELLM_MASTER_KEY}`,
    };

    const requestBody = {
        model: modelString,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        messages: allMessages,
    };

    const body = JSON.stringify(requestBody);
    const requestOpts = {
        hostname: proxyUrl.hostname,
        port: parseInt(proxyUrl.port, 10) || 4000,
        path: proxyUrl.pathname,
        method: 'POST',
        headers: requestHeaders,
        protocol: proxyUrl.protocol,
    };

    const response = await httpRequest(requestOpts, body);
    const data = JSON.parse(response) as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    const text = choices?.[0]?.message?.content ?? '';
    const usage = data.usage as { prompt_tokens: number; completion_tokens: number } | undefined;
    const config = parseModelString(modelString);

    return {
        text,
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        costUsd: calculateCost(config.model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
        model: modelString,
        durationMs: Date.now() - start,
    };
}
