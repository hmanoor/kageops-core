/**
 * Google Gemini provider. Uses generativelanguage.googleapis.com with the
 * API key passed as a `?key=` query parameter. Streaming uses its own SSE
 * format (data-prefixed JSON lines, not OpenAI-style), so we handle parsing
 * locally rather than reusing the shared accumulator.
 */

import { resolveProviderApiKey } from './api-keys';
import { calculateCost } from './cost';
import { httpRequest, httpStreamRequest } from './http';
import type { AiRequestOptions, AiResponse, ProviderConfig } from './types';

export async function sendGeminiPrompt(
    config: ProviderConfig,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions
): Promise<AiResponse> {
    const apiKey = await resolveProviderApiKey('gemini', config.apiKey);

    if (apiKey === null || apiKey === '') {
        throw new Error('GOOGLE_API_KEY is required for Gemini provider.');
    }

    const body = JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
            maxOutputTokens: options.maxTokens ?? 4096,
            temperature: options.temperature ?? 0.7,
        },
    });

    if (options.onStream !== undefined) {
        return sendGeminiStreaming(config, apiKey, body, options.onStream);
    }

    const response = await httpRequest({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${config.model}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    }, body);

    const data = JSON.parse(response) as Record<string, unknown>;
    const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> } }> | undefined;
    const text = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const usageMetadata = data.usageMetadata as { promptTokenCount: number; candidatesTokenCount: number } | undefined;

    return {
        text,
        tokensIn: usageMetadata?.promptTokenCount ?? 0,
        tokensOut: usageMetadata?.candidatesTokenCount ?? 0,
        costUsd: calculateCost(config.model, usageMetadata?.promptTokenCount ?? 0, usageMetadata?.candidatesTokenCount ?? 0),
        model: config.model,
        durationMs: 0,
    };
}

async function sendGeminiStreaming(
    config: ProviderConfig,
    apiKey: string,
    body: string,
    onStream: (chunk: string) => void
): Promise<AiResponse> {
    let accumulated = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let jsonBuffer = '';

    await httpStreamRequest(
        {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${config.model}:streamGenerateContent?alt=sse&key=${apiKey}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        },
        body,
        (chunk: string) => {
            jsonBuffer += chunk;

            const lines = jsonBuffer.split('\n');
            jsonBuffer = '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '' || trimmed.startsWith(':')) {
                    continue;
                }

                let jsonStr = trimmed;
                if (trimmed.startsWith('data:')) {
                    jsonStr = trimmed.slice(5).trim();
                }

                if (jsonStr === '' || jsonStr === '[DONE]') {
                    continue;
                }

                try {
                    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
                    const candidates = parsed.candidates as Array<{
                        content: { parts: Array<{ text: string }> };
                    }> | undefined;
                    const text = candidates?.[0]?.content?.parts?.[0]?.text;
                    if (text !== undefined) {
                        accumulated += text;
                        onStream(text);
                    }
                    const usageMetadata = parsed.usageMetadata as {
                        promptTokenCount?: number;
                        candidatesTokenCount?: number;
                    } | undefined;
                    if (usageMetadata?.promptTokenCount !== undefined) {
                        tokensIn = usageMetadata.promptTokenCount;
                    }
                    if (usageMetadata?.candidatesTokenCount !== undefined) {
                        tokensOut = usageMetadata.candidatesTokenCount;
                    }
                } catch {
                    // Incomplete JSON — re-buffer for next chunk
                    jsonBuffer += jsonStr;
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
