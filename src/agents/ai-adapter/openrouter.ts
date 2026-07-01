/**
 * OpenRouter provider — OpenAI-compatible endpoint that fans out to many
 * upstream models. Streaming reuses the shared OpenAI-style SSE handler.
 */

import { resolveProviderApiKey } from './api-keys';
import { calculateCost } from './cost';
import { httpRequest } from './http';
import { sendOpenAiStyleStreaming } from './openai';
import type { AiRequestOptions, AiResponse, ProviderConfig } from './types';

export async function sendOpenRouterPrompt(
    config: ProviderConfig,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions
): Promise<AiResponse> {
    const apiKey = await resolveProviderApiKey('openrouter', config.apiKey);

    if (apiKey === null || apiKey === '') {
        throw new Error('OPENROUTER_API_KEY is required for OpenRouter provider.');
    }

    const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    const requestBody = {
        model: config.model,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        ...(options.onStream !== undefined ? { stream: true } : {}),
    };

    const body = JSON.stringify(requestBody);

    if (options.onStream !== undefined) {
        return sendOpenAiStyleStreaming(
            config,
            'openrouter.ai',
            '/api/v1/chat/completions',
            requestHeaders,
            body,
            options.onStream
        );
    }

    const response = await httpRequest({
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: requestHeaders,
    }, body);

    const data = JSON.parse(response) as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    const text = choices?.[0]?.message?.content ?? '';
    const usage = data.usage as { prompt_tokens: number; completion_tokens: number } | undefined;

    return {
        text,
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        costUsd: calculateCost(config.model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
        model: config.model,
        durationMs: 0,
    };
}
