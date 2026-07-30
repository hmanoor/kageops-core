/**
 * Refusal as a first-class outcome.
 *
 * The problem this fixes: when a self-heal loop exhausts its budget we used to
 * escalate with a prose string ("acceptance gate failed after 3 attempts —
 * still missing: ..."). Two things went wrong with that.
 *
 *   1. The *structure* was already computed and then thrown away. The
 *      acceptance gate produces objects with `check` / `expected` / `message` /
 *      `severity`; joining them into English means the next planner turn — and
 *      the UI — get prose they have to re-parse or simply cannot act on.
 *
 *   2. There was no terminal state. The escalation surfaced as an ordinary
 *      phase gate with Approve/Deny buttons, and "approve" cannot satisfy
 *      "this needs a human to fix it" — so the gate re-evaluated, refused
 *      again, and re-raised. Observed ~70 times against an auto-approving
 *      harness (BPF-28).
 *
 * The shape below treats a refusal the way a type system would: a terminal,
 * non-retryable result that closes an intent and names what would have to
 * change. A new attempt is a NEW intent, not a retry of the dead one — which
 * also means a loop cannot spin without new information, catching the
 * time-and-token burn that a dollar cap never sees.
 *
 * Credit: the shape was sharpened in conversation with the author of Agent
 * Pump, who hit the identical failure with a wallet boundary — an agent that
 * was financially safe yet hit INSUFFICIENT_BALANCE 46 times because the
 * failure came back as a retryable tool error.
 */

/** Why a run refused. Extend deliberately — each value is a contract. */
export type RefusalReason =
    | 'acceptance-violations'
    | 'build-failed'
    | 'deploy-preview-failed';

/** One machine-readable reason the work was rejected. Mirrors the acceptance
 *  gate's violation shape so no structure is lost in translation. */
export interface RefusalDetail {
    /** Stable check id, e.g. "missing-id", "unbalanced-css-braces". */
    readonly check: string;
    /** What the brief required. */
    readonly expected: string;
    /** Human-readable explanation of the gap. */
    readonly message: string;
    /** "must" blocks; "should" warns. */
    readonly severity: string;
}

/** Best artifact produced across the attempts, preserved across the refusal so
 *  the human inherits the least-broken version rather than the last one. */
export interface BestAttempt {
    readonly violations: number;
    readonly restored: boolean;
}

/**
 * A terminal, non-retryable outcome. `retryable` is typed as the literal
 * `false` on purpose: nothing can construct a "retryable refusal", so a
 * caller cannot accidentally feed one back into a retry loop.
 */
export interface Refusal {
    readonly status: 'refused';
    readonly reason: RefusalReason;
    /** Always false. A refusal closes its intent; a further attempt is new. */
    readonly retryable: false;
    /** Always true. Distinguishes this from an ordinary phase gate. */
    readonly humanActionRequired: true;
    /**
     * Identifies the intent this refusal closes. Deterministic, so a repeated
     * refusal of the same intent is recognisable as the SAME closed intent
     * rather than a fresh escalation — this is what stops the re-raise loop.
     */
    readonly intentId: string;
    /** How many remediation attempts were spent before refusing. */
    readonly attemptsMade: number;
    /** One-line summary for logs and notifications. */
    readonly summary: string;
    /** The structured reasons. Never flattened to prose in transit. */
    readonly details: readonly RefusalDetail[];
    readonly bestAttempt?: BestAttempt;
    /** What would have to change for a new attempt to be worth making. */
    readonly premiseForRetry: string;
}

export interface CreateRefusalArgs {
    readonly reason: RefusalReason;
    readonly projectId: string;
    readonly phase: string;
    readonly attemptsMade: number;
    readonly details: readonly RefusalDetail[];
    readonly bestAttempt?: BestAttempt;
    readonly premiseForRetry?: string;
}

/** Deterministic intent id: same project + phase + reason = same intent. */
export function refusalIntentId(projectId: string, phase: string, reason: RefusalReason): string {
    return `${projectId}:${phase}:${reason}`;
}

const DEFAULT_PREMISE: Record<RefusalReason, string> = {
    'acceptance-violations':
        'The brief or the artifact must change — either the missing elements are '
        + 'added, or the requirement is amended. Re-running the same agents against '
        + 'the same brief will reproduce this result.',
    'build-failed':
        'The build error must be addressed, or the build command / project type '
        + 'corrected. Another attempt with no change will fail identically.',
    'deploy-preview-failed':
        'Deployment credentials or target configuration must change before a '
        + 'further attempt is meaningful.',
};

export function createRefusal(args: CreateRefusalArgs): Refusal {
    const summary = buildSummary(args);
    return {
        status: 'refused',
        reason: args.reason,
        retryable: false,
        humanActionRequired: true,
        intentId: refusalIntentId(args.projectId, args.phase, args.reason),
        attemptsMade: args.attemptsMade,
        summary,
        details: args.details,
        ...(args.bestAttempt !== undefined ? { bestAttempt: args.bestAttempt } : {}),
        premiseForRetry: args.premiseForRetry ?? DEFAULT_PREMISE[args.reason],
    };
}

function buildSummary(args: CreateRefusalArgs): string {
    const attempts = `${args.attemptsMade} remediation attempt${args.attemptsMade === 1 ? '' : 's'}`;
    const blocking = args.details.filter((d) => d.severity === 'must');
    const what = blocking.length > 0
        ? blocking.map((d) => d.expected).join(', ')
        : args.details.map((d) => d.check).join(', ');
    switch (args.reason) {
        case 'acceptance-violations':
            return `Cannot complete: acceptance gate still failing after ${attempts}`
                + `${what !== '' ? ` — missing ${what}` : ''}`;
        case 'build-failed':
            return `Cannot complete: build still failing after ${attempts}`;
        case 'deploy-preview-failed':
            return `Cannot complete: deploy preview still failing after ${attempts}`;
    }
}

/** Type guard for values arriving from the event bus or the DB as `unknown`. */
export function isRefusal(value: unknown): value is Refusal {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return v['status'] === 'refused'
        && v['retryable'] === false
        && typeof v['intentId'] === 'string'
        && typeof v['reason'] === 'string';
}

/**
 * Render a refusal for an agent prompt. Deliberately keeps the structure
 * visible (one line per check) AND states that the intent is closed, so a
 * model reading this is told it must account for a changed premise rather
 * than simply try again.
 */
export function formatRefusalForPrompt(refusal: Refusal): string {
    const lines = refusal.details.map(
        (d) => `- [${d.severity}] ${d.check}: expected ${d.expected} — ${d.message}`
    );
    return [
        `REFUSED (terminal, not retryable): ${refusal.summary}`,
        `Intent ${refusal.intentId} is closed after ${refusal.attemptsMade} attempt(s).`,
        '',
        'Unmet requirements:',
        ...lines,
        '',
        `To justify a new attempt, state what premise changed. ${refusal.premiseForRetry}`,
    ].join('\n');
}

/** One-line human rendering for notifications and log lines. */
export function formatRefusalForHuman(refusal: Refusal): string {
    const best = refusal.bestAttempt !== undefined
        ? ` (workspace restored to best attempt with ${refusal.bestAttempt.violations} violation`
          + `${refusal.bestAttempt.violations === 1 ? '' : 's'})`
        : '';
    return `${refusal.summary}${best} — human action required`;
}
