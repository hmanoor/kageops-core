/**
 * AI Adapter — shared types.
 *
 * Public surface re-exported from ../ai-adapter.ts. Callers should
 * import from there, not directly from this file, so the split can
 * evolve without breaking downstream code.
 */

export interface AiResponse {
    readonly text: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
    readonly model: string;
    readonly durationMs: number;
}

/**
 * Optional Agent Terminal (B-497) wiring — when provided to a streamed
 * subprocess provider (currently only `claude-cli`), the provider tags
 * each stdout chunk with these fields and routes it to the Agent
 * Terminal panel via the `subprocess.output` event bus channel.
 *
 * Routing through the bus is fire-and-forget — providers MUST continue
 * to function even if `terminal.publish` rejects.
 */
export interface AiTerminalContext {
    readonly projectId: string;
    readonly publish: (event: {
        readonly projectId?: string;
        readonly taskId?: string;
        readonly agent?: string;
        readonly data: Record<string, unknown>;
    }) => Promise<void>;
    readonly taskId?: string;
    readonly agent?: string;
}

export interface AiRequestOptions {
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly onStream?: (chunk: string) => void;
    readonly terminal?: AiTerminalContext;
    /**
     * Working directory for subprocess providers (currently only `claude-cli`).
     * The Claude CLI reads `CLAUDE.md`, project memory, and writes files relative
     * to this directory. If unset, the subprocess inherits the parent process's
     * cwd — which for KageOps is the *KageOps repo* and causes cross-contamination
     * (CLI thinks it's working on KageOps, writes output files into the KageOps
     * source tree). The agent base class defaults this to `task.repoPath`.
     */
    readonly cwd?: string;
}

export type AiProvider =
    | 'claude'
    | 'claude-cli'
    | 'codex-cli'
    | 'openrouter'
    | 'ollama'
    | 'openai'
    | 'gemini';

export interface ProviderConfig {
    readonly provider: AiProvider;
    readonly model: string;
    readonly apiKey?: string;
    readonly baseUrl?: string;
}

export interface ConversationMessage {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
}

export type HttpErrorClass =
    | 'rate-limit'
    | 'timeout'
    | 'server-error'
    | 'auth-error'
    | 'client-error';
