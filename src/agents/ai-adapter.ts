/**
 * KageOps AI Model Adapter — public barrel.
 *
 * The adapter is split across `./ai-adapter/*` per-provider modules. This
 * file preserves the single-import public surface that 38+ consumers rely
 * on: `sendPrompt`, `sendConversation`, types, and utilities.
 *
 * See `./ai-adapter/dispatcher.ts` for the provider switch, and each
 * per-provider file for protocol-specific logic.
 */

export { sendConversation, sendPrompt } from './ai-adapter/dispatcher';
export { _resetClaudeCliPathCacheForTests } from './ai-adapter/claude-cli';
export { classifyHttpError, stripThinkingTags } from './ai-adapter/text-utils';
export type {
    AiProvider,
    AiRequestOptions,
    AiResponse,
    ConversationMessage,
    HttpErrorClass,
} from './ai-adapter/types';

// Resilience helpers re-exported so existing `from './ai-adapter'` imports
// continue to work without fanning out across callers.
export {
    _resetNetworkTransientListenerForTests,
    isNetworkTransientError,
    onNetworkTransient,
    sanitizeSpawnArgs,
    stripNullBytes,
} from './ai-adapter-resilience';
