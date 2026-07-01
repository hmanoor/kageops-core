/**
 * OpenAI provider — standard /v1/chat/completions protocol.
 *
 * Exports the shared `sendOpenAiStyleStreaming` helper that OpenRouter
 * and the LiteLLM proxy also use, since they speak the same SSE format
 * (`choices[].delta.content`).
 */

import { createStreamAccumulator } from '../ai-adapter-streaming';
import { resolveProviderApiKey } from './api-keys';
import { calculateCost } from './cost';
import { httpRequest, httpStreamRequest } from './http';
import type { AiRequestOptions, AiResponse, ProviderConfig } from './types';

/**
 * GPT-5 family + o1/o3 reasoning models reject `max_tokens` ("Unsupported
 * parameter") and require `max_completion_tokens`. Detect by id prefix —
 * the model string here is the bare id (no `openai/` prefix), since the
 * dispatcher strips that before calling the adapter.
 */
function requiresMaxCompletionTokens(model: string): boolean {
    const id = model.startsWith('openai/') ? model.slice('openai/'.length) : model;
    return /^(gpt-5|o1|o3|o4|gpt-6)/i.test(id);
}

/**
 * GPT-5 family + o1/o3/o4 reasoning models reject any non-default
 * temperature ("Unsupported value: 'temperature' does not support X
 * with this model. Only the default (1) value is supported."). The
 * api-side detection is identical to the max_tokens rename — same model
 * families, same behavior. Caller must omit the field entirely; sending
 * `temperature: 1` also fails on some endpoints.
 */
function rejectsCustomTemperature(model: string): boolean {
    const id = model.startsWith('openai/') ? model.slice('openai/'.length) : model;
    return /^(gpt-5|o1|o3|o4|gpt-6)/i.test(id);
}

export async function sendOpenAiPrompt(
    config: ProviderConfig,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions
): Promise<AiResponse> {
    const apiKey = await resolveProviderApiKey('openai', config.apiKey);

    if (apiKey === null || apiKey === '') {
        throw new Error('OPENAI_API_KEY is required for OpenAI provider.');
    }

    const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    // GPT-5 family and o1/o3 reasoning models reject `max_tokens` and require
    // `max_completion_tokens` instead. Older GPT-4o / GPT-4 / GPT-3.5 still
    // accept `max_tokens`. Pick the right field per model.
    const tokenCap = options.maxTokens ?? 4096;
    const tokenField = requiresMaxCompletionTokens(config.model)
        ? { max_completion_tokens: tokenCap }
        : { max_tokens: tokenCap };

    const tempField = rejectsCustomTemperature(config.model)
        ? {}
        : { temperature: options.temperature ?? 0.7 };

    const requestBody = {
        model: config.model,
        ...tokenField,
        ...tempField,
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
            'api.openai.com',
            '/v1/chat/completions',
            requestHeaders,
            body,
            options.onStream
        );
    }

    const response = await httpRequest({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
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

/**
 * Shared streaming handler for OpenAI-compatible APIs (OpenAI, OpenRouter,
 * LiteLLM proxy). Parses SSE events with `choices[0].delta.content` payloads.
 */
export async function sendOpenAiStyleStreaming(
    config: ProviderConfig,
    hostname: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    onStream: (chunk: string) => void,
    protocol?: string,
    port?: number
): Promise<AiResponse> {
    let accumulated = '';
    const accumulator = createStreamAccumulator();

    await httpStreamRequest(
        { hostname, path, method: 'POST', headers, protocol, port },
        body,
        (chunk: string) => {
            const events = accumulator.feed(chunk);
            for (const event of events) {
                if (event.data === '[DONE]') {
                    continue;
                }

                try {
                    const parsed = JSON.parse(event.data) as Record<string, unknown>;
                    const choices = parsed.choices as Array<{
                        delta: { content?: string };
                    }> | undefined;
                    const content = choices?.[0]?.delta?.content;
                    if (content !== undefined) {
                        accumulated += content;
                        onStream(content);
                    }
                } catch {
                    // Malformed JSON in SSE data — skip
                }
            }
        }
    );

    return {
        text: accumulated,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: config.model,
        durationMs: 0,
    };
}
