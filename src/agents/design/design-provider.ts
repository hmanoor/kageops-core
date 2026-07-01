/**
 * DesignProvider — pluggable UI/UX generation surface.
 *
 * Mirrors the AIAdapter pattern: multiple implementations behind one
 * interface so Pixel can delegate design generation to an external
 * service (Vercel v0, Figma, Stitch when it publishes pricing) or
 * stay in-house. All providers report cost_usd so the global
 * KAGEOPS_MAX_RUN_USD budget-kill enforces uniformly.
 */

export type DesignArtifactKind = 'react' | 'html' | 'markdown' | 'figma';

export interface DesignSpec {
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    /** What we want out: React component, static HTML, or a design doc. */
    readonly outputKind: DesignArtifactKind;
    /** Optional — upstream design brief / wireframe text to anchor the generation. */
    readonly brief?: string;
    /** Optional Figma file URL for providers that ingest designs (Locofy/Anima/Figma MCP). */
    readonly figmaUrl?: string;
}

export interface DesignFile {
    readonly path: string;
    readonly content: string;
}

export interface DesignArtifact {
    readonly kind: DesignArtifactKind;
    readonly files: readonly DesignFile[];
    readonly previewUrl?: string;
    readonly costUsd: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly provider: string;
    readonly durationMs: number;
}

export interface CostEstimate {
    readonly usd: number;
    /** Confidence: 'published' when provider has public per-call pricing, 'heuristic' otherwise. */
    readonly confidence: 'published' | 'heuristic' | 'unknown';
}

export interface DesignProvider {
    readonly name: string;

    /**
     * Returns true if this provider is configured and usable right now.
     * (Auth present, API reachable, pricing published.)
     */
    isAvailable(): Promise<boolean>;

    /**
     * Pre-flight cost check. Used by budget-kill to refuse unpriced runs
     * unless KAGEOPS_ALLOW_UNPRICED_DESIGN=1.
     */
    estimateCost(spec: DesignSpec): Promise<CostEstimate>;

    /**
     * Generate the design artifact. MUST throw DesignProviderError on any
     * non-recoverable failure so the caller can fall back to in-house.
     */
    generateUI(spec: DesignSpec): Promise<DesignArtifact>;
}

/**
 * Raised when an external provider call fails in a way the caller can
 * recover from (network, auth, rate-limit, bad response). Wraps the root
 * cause so callers can decide to fall back to in-house without losing
 * diagnostics.
 */
export class DesignProviderError extends Error {
    readonly provider: string;
    readonly recoverable: boolean;
    readonly cause?: unknown;

    constructor(
        provider: string,
        message: string,
        opts: { recoverable: boolean; cause?: unknown } = { recoverable: true }
    ) {
        super(`[${provider}] ${message}`);
        this.name = 'DesignProviderError';
        this.provider = provider;
        this.recoverable = opts.recoverable;
        this.cause = opts.cause;
    }
}

/**
 * Provider identifier stored on the `projects` row. Adding a new value
 * here is the only place a provider needs to register.
 */
export type DesignProviderId = 'in-house' | 'claude-ui' | 'openai-ui' | 'v0' | 'figma' | 'locofy';

export const DEFAULT_DESIGN_PROVIDER: DesignProviderId = 'in-house';

export function isDesignProviderId(value: unknown): value is DesignProviderId {
    return (
        value === 'in-house' ||
        value === 'claude-ui' ||
        value === 'openai-ui' ||
        value === 'v0' ||
        value === 'figma' ||
        value === 'locofy'
    );
}
