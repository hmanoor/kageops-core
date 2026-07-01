/**
 * Anthropic Claude API provider.
 *
 * Speaks the `/v1/messages` protocol (x-api-key + anthropic-version header).
 * Falls back to the Claude CLI when no API key is configured, so users on
 * the claude.ai subscription can still run through the `claude/...` model
 * string without a paid API plan.
 */

import { createStreamAccumulator } from '../ai-adapter-streaming';
import { resolveProviderApiKey } from './api-keys';
import { sendClaudeCliPrompt } from './claude-cli';
import { calculateCost } from './cost';
import { httpRequest, httpStreamRequest } from './http';
import type { AiRequestOptions, AiResponse, ConversationMessage, ProviderConfig } from './types';

export async function sendClaudePrompt(
    config: ProviderConfig,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions
): Promise<AiResponse> {
    const apiKey = await resolveProviderApiKey('claude', config.apiKey);

    if (apiKey === null || apiKey === '') {
        // Fall back to Claude CLI — preserve the caller's model + streaming preference
        return sendClaudeCliPrompt(config, systemPrompt, userPrompt, options);
    }

    const requestHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    };

    const requestBody = {
        model: config.model,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        ...(options.onStream !== undefined ? { stream: true } : {}),
    };

    const body = JSON.stringify(requestBody);

    if (options.onStream !== undefined) {
        return sendClaudeStreaming(config, requestHeaders, body, options.onStream);
    }

    const response = await httpRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: requestHeaders,
    }, body);

    const data = JSON.parse(response) as Record<string, unknown>;
    const content = data.content as Array<{ type: string; text: string }>;
    const text = content?.find((c) => c.type === 'text')?.text ?? '';
    const usage = data.usage as { input_tokens: number; output_tokens: number } | undefined;

    return {
        text,
        tokensIn: usage?.input_tokens ?? 0,
        tokensOut: usage?.output_tokens ?? 0,
        costUsd: calculateCost(config.model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0),
        model: config.model,
        durationMs: 0,
    };
}

async function sendClaudeStreaming(
    config: ProviderConfig,
    headers: Record<string, string>,
    body: string,
    onStream: (chunk: string) => void
): Promise<AiResponse> {
    let accumulated = '';
    let tokensIn = 0;
    let tokensOut = 0;
    const accumulator = createStreamAccumulator();

    await httpStreamRequest(
        {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers,
        },
        body,
        (chunk: string) => {
            const events = accumulator.feed(chunk);
            for (const event of events) {
                if (event.data === '[DONE]') {
                    continue;
                }

                try {
                    const parsed = JSON.parse(event.data) as Record<string, unknown>;
                    const eventType = parsed.type as string | undefined;

                    if (eventType === 'content_block_delta') {
                        const delta = parsed.delta as { type: string; text: string } | undefined;
                        if (delta?.text !== undefined) {
                            accumulated += delta.text;
                            onStream(delta.text);
                        }
                    } else if (eventType === 'message_delta') {
                        const usage = parsed.usage as { output_tokens: number } | undefined;
                        if (usage?.output_tokens !== undefined) {
                            tokensOut = usage.output_tokens;
                        }
                    } else if (eventType === 'message_start') {
                        const message = parsed.message as { usage?: { input_tokens: number } } | undefined;
                        if (message?.usage?.input_tokens !== undefined) {
                            tokensIn = message.usage.input_tokens;
                        }
                    }
                } catch {
                    // Malformed JSON in SSE data — skip
                }
            }
        }
    );

    return {
        text: accumulated,
        tokensIn,
        tokensOut,
        costUsd: calculateCost(config.model, tokensIn, tokensOut),
        model: config.model,
        durationMs: 0,
    };
}

export async function sendClaudeConversation(
    config: ProviderConfig,
    systemPrompt: string,
    messages: readonly ConversationMessage[],
    options: AiRequestOptions
): Promise<AiResponse> {
    const apiKey = await resolveProviderApiKey('claude', config.apiKey);

    if (apiKey === null || apiKey === '') {
        // Fall back to single-turn CLI — flatten conversation and preserve options.
        const userPrompt = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
        return sendClaudeCliPrompt(config, systemPrompt, userPrompt, options);
    }

    const requestHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    };

    // Convert conversation messages to Claude's format (user/assistant turns)
    const claudeMessages = messages.map((m) => ({
        role: m.role === 'system' ? 'user' as const : m.role,
        content: m.content,
    }));

    const requestBody = {
        model: config.model,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        system: systemPrompt,
        messages: claudeMessages,
    };

    const body = JSON.stringify(requestBody);

    const response = await httpRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: requestHeaders,
    }, body);

    const data = JSON.parse(response) as Record<string, unknown>;
    const content = data.content as Array<{ type: string; text: string }>;
    const text = content?.find((c) => c.type === 'text')?.text ?? '';
    const usage = data.usage as { input_tokens: number; output_tokens: number } | undefined;

    return {
        text,
        tokensIn: usage?.input_tokens ?? 0,
        tokensOut: usage?.output_tokens ?? 0,
        costUsd: calculateCost(config.model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0),
        model: config.model,
        durationMs: 0,
    };
}
