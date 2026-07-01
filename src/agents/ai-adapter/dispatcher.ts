/**
 * Top-level provider dispatcher.
 *
 * `sendPrompt` / `sendConversation` wrap the retry loop and route to the
 * provider-specific implementation based on the parsed model string.
 * If LITELLM_PROXY_URL is set, every call is rerouted through the proxy
 * regardless of provider.
 */

import { withNetworkRetry } from '../ai-adapter-resilience';
import { sendClaudeConversation, sendClaudePrompt } from './claude-api';
import { sendClaudeCliPrompt } from './claude-cli';
import { sendCodexCliPrompt } from './codex-cli';
import { sendGeminiPrompt } from './gemini';
import { LITELLM_PROXY_URL, sendViaLiteLLM, sendViaLiteLLMConversation } from './litellm';
import { parseModelString } from './model-parser';
import { sendOllamaConversation, sendOllamaPrompt } from './ollama';
import { sendOpenAiPrompt } from './openai';
import { sendOpenRouterPrompt } from './openrouter';
import type { AiRequestOptions, AiResponse, ConversationMessage } from './types';

/**
 * Send a prompt to any AI provider.
 * Model string format: "provider/model-name" (e.g., "claude/claude-sonnet-4-20250514", "ollama/llama3.2")
 */
export async function sendPrompt(
    modelString: string,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions = {}
): Promise<AiResponse> {
    return withNetworkRetry(modelString, () =>
        sendPromptOnce(modelString, systemPrompt, userPrompt, options)
    );
}

async function sendPromptOnce(
    modelString: string,
    systemPrompt: string,
    userPrompt: string,
    options: AiRequestOptions
): Promise<AiResponse> {
    // Opt-in LiteLLM proxy routing — set LITELLM_PROXY_URL env var to enable
    if (LITELLM_PROXY_URL !== null) {
        return sendViaLiteLLM(modelString, systemPrompt, userPrompt, options);
    }

    const config = parseModelString(modelString);
    const start = Date.now();

    let result: AiResponse;

    switch (config.provider) {
        case 'claude':
            result = await sendClaudePrompt(config, systemPrompt, userPrompt, options);
            break;
        case 'claude-cli':
            result = await sendClaudeCliPrompt(config, systemPrompt, userPrompt, options);
            break;
        case 'codex-cli':
            result = await sendCodexCliPrompt(config, systemPrompt, userPrompt, options);
            break;
        case 'openrouter':
            result = await sendOpenRouterPrompt(config, systemPrompt, userPrompt, options);
            break;
        case 'ollama':
            result = await sendOllamaPrompt(config, systemPrompt, userPrompt, options);
            break;
        case 'openai':
            result = await sendOpenAiPrompt(config, systemPrompt, userPrompt, options);
            break;
        case 'gemini':
            result = await sendGeminiPrompt(config, systemPrompt, userPrompt, options);
            break;
        default:
            throw new Error(`Unsupported AI provider: ${config.provider}`);
    }

    return { ...result, durationMs: Date.now() - start };
}

/**
 * Send a multi-turn conversation to any AI provider.
 * Supports full conversation history for context-aware responses.
 */
export async function sendConversation(
    modelString: string,
    systemPrompt: string,
    messages: readonly ConversationMessage[],
    options: AiRequestOptions = {}
): Promise<AiResponse> {
    return withNetworkRetry(modelString, () =>
        sendConversationOnce(modelString, systemPrompt, messages, options)
    );
}

async function sendConversationOnce(
    modelString: string,
    systemPrompt: string,
    messages: readonly ConversationMessage[],
    options: AiRequestOptions
): Promise<AiResponse> {
    if (LITELLM_PROXY_URL !== null) {
        return sendViaLiteLLMConversation(modelString, systemPrompt, messages, options);
    }

    const config = parseModelString(modelString);
    const start = Date.now();

    let result: AiResponse;

    switch (config.provider) {
        case 'claude':
            result = await sendClaudeConversation(config, systemPrompt, messages, options);
            break;
        case 'ollama':
            result = await sendOllamaConversation(config, systemPrompt, messages, options);
            break;
        case 'claude-cli':
        case 'codex-cli':
        case 'openrouter':
        case 'openai':
        case 'gemini': {
            // For providers without native multi-turn support, flatten to a
            // single prompt and delegate to sendPrompt. Use the single-shot
            // variant so we don't double-wrap the retry loop.
            const userPrompt = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
            result = await sendPromptOnce(modelString, systemPrompt, userPrompt, options);
            break;
        }
        default:
            throw new Error(`Unsupported AI provider: ${config.provider}`);
    }

    return { ...result, durationMs: Date.now() - start };
}
