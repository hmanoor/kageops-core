/**
 * Ollama provider — supports both local Ollama (http://localhost:11434)
 * and Ollama cloud (https://ollama.com). Streaming uses NDJSON rather
 * than SSE. Reasoning models may emit <think>…</think> blocks that we
 * strip before returning.
 */

import { parseNDJSONChunk } from '../ai-adapter-streaming';
import { resolveProviderApiKey } from './api-keys';
import { estimateTokens } from './cost';
import { httpRequest, httpStreamRequest, type HttpRequestOptions } from './http';
import { stripThinkingTags } from './text-utils';
import type { AiRequestOptions, AiResponse, ConversationMessage, ProviderConfig } from './types';

/**
 * Resolve Ollama connection details. Supports both local Ollama
 * (http://localhost:11434) and Ollama cloud (https://ollama.com).
 *
 * Cloud detection: OLLAMA_API_KEY env var is set, or OLLAMA_HOST
 * points to ollama.com. Cloud requests use Bearer auth.
 */
async function resolveOllamaConnection(config: ProviderConfig): Promise<{
    readonly baseUrl: string;
    readonly headers: Record<string, string>;
    readonly isCloud: boolean;
}> {
    const resolvedKey = await resolveProviderApiKey('ollama', config.apiKey);
    const apiKey = resolvedKey ?? '';
    const hostEnv = process.env['OLLAMA_HOST'] ?? '';

    const isCloud = apiKey !== '' || hostEnv.includes('ollama.com');

    const baseUrl = isCloud
        ? (hostEnv !== '' && hostEnv.includes('ollama.com') ? hostEnv : 'https://ollama.com')
        : (config.baseUrl ?? (hostEnv || 'http://localhost:11434'));

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (apiKey !== '') {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    return { baseUrl, headers, isCloud };
}

export async function sendOllamaPrompt(
    config: ProviderConfig,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions
): Promise<AiResponse> {
    const { baseUrl, headers, isCloud } = await resolveOllamaConnection(config);
    const url = new URL('/api/generate', baseUrl);
    const useStreaming = options.onStream !== undefined;

    const body = JSON.stringify({
        model: config.model,
        system: systemPrompt,
        prompt: userPrompt,
        stream: useStreaming,
        options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.maxTokens ?? 4096,
        },
    });

    const requestOpts: HttpRequestOptions = {
        hostname: url.hostname,
        port: url.port !== '' ? parseInt(url.port, 10) : (isCloud ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers,
        protocol: url.protocol,
    };

    if (useStreaming) {
        return sendOllamaStreaming(config, requestOpts, body, systemPrompt, userPrompt, options.onStream!);
    }

    const response = await httpRequest(requestOpts, body);

    const data = JSON.parse(response) as Record<string, unknown>;
    const raw = (data.response as string) ?? '';
    // Reasoning models prefix answers with <think>...</think> — strip before returning
    const text = stripThinkingTags(raw);

    return {
        text,
        tokensIn: estimateTokens(systemPrompt + userPrompt),
        tokensOut: estimateTokens(text),
        costUsd: 0,
        model: config.model,
        durationMs: 0,
    };
}

async function sendOllamaStreaming(
    config: ProviderConfig,
    requestOpts: HttpRequestOptions,
    body: string,
    systemPrompt: string,
    userPrompt: string,
    onStream: (chunk: string) => void
): Promise<AiResponse> {
    let accumulated = '';

    await httpStreamRequest(
        requestOpts,
        body,
        (chunk: string) => {
            const parsed = parseNDJSONChunk(chunk);
            for (const item of parsed) {
                const obj = item as Record<string, unknown>;
                const response = obj.response as string | undefined;
                if (response !== undefined) {
                    accumulated += response;
                    onStream(response);
                }
            }
        }
    );

    const text = stripThinkingTags(accumulated);

    return {
        text,
        tokensIn: estimateTokens(systemPrompt + userPrompt),
        tokensOut: estimateTokens(text),
        costUsd: 0,
        model: config.model,
        durationMs: 0,
    };
}

export async function sendOllamaConversation(
    config: ProviderConfig,
    systemPrompt: string,
    messages: readonly ConversationMessage[],
    options: AiRequestOptions
): Promise<AiResponse> {
    const { baseUrl, headers, isCloud } = await resolveOllamaConnection(config);
    const url = new URL('/api/chat', baseUrl);

    const ollamaMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body = JSON.stringify({
        model: config.model,
        messages: ollamaMessages,
        stream: false,
        options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.maxTokens ?? 4096,
        },
    });

    const requestOpts: HttpRequestOptions = {
        hostname: url.hostname,
        port: url.port !== '' ? parseInt(url.port, 10) : (isCloud ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers,
        protocol: url.protocol,
    };

    const response = await httpRequest(requestOpts, body);
    const data = JSON.parse(response) as Record<string, unknown>;
    const message = data.message as { content: string } | undefined;
    const raw = message?.content ?? '';
    const text = stripThinkingTags(raw);

    const allContent = systemPrompt + messages.map((m) => m.content).join('');
    return {
        text,
        tokensIn: estimateTokens(allContent),
        tokensOut: estimateTokens(text),
        costUsd: 0,
        model: config.model,
        durationMs: 0,
    };
}
