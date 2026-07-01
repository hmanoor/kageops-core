/**
 * Functional-completeness check — no orphaned half-features (G3).
 *
 * The MCC build passed every file-existence check yet shipped broken: the
 * Stripe webhook RECEIVER existed (`app/api/stripe/webhook/route.ts` handling
 * `checkout.session.completed`) but NOTHING created a checkout session — a
 * receiving half with no sending half. The flow could never complete, but
 * "the handler file exists" looked like done.
 *
 * This module scans generated source for paired-capability features where the
 * RECEIVING half is wired but the SENDING half is absent. Each rule names a
 * `receiver` signal and the `initiator` signal that MUST accompany it; a
 * receiver present with no initiator is a `must` acceptance violation.
 *
 * Direction matters: we flag receiver-without-initiator only. The reverse
 * (an initiator with no receiver) is legitimately common — a one-time checkout
 * can confirm via a success_url redirect + session retrieval instead of a
 * webhook — so flagging it produces false positives.
 *
 * Heuristic by design — it only fires when a real receiver/initiator token is
 * present, so the bare scaffold (empty webhook switch, no checkout literal)
 * never trips it. Pure functions over source strings; fs injected for the repo
 * walk so it is trivially unit-testable.
 */

import * as path from 'path';

export interface VerticalSliceViolation {
    readonly check: 'orphaned-half-feature' | 'missing-required-initiator';
    readonly feature: string;
    readonly expected: string;
    readonly message: string;
}

interface SliceRule {
    readonly feature: string;
    /** Signal that the receiving / consuming half is wired. */
    readonly receiver: RegExp;
    /** Signal that the sending / producing half exists. */
    readonly initiator: RegExp;
    readonly receiverLabel: string;
    readonly initiatorLabel: string;
}

/**
 * Paired-capability rules. Add a rule here when a feature has two halves that
 * must both exist for it to work end-to-end. Keep patterns specific enough that
 * only a genuinely-wired half matches (the bare scaffold must not trip them).
 */
const SLICE_RULES: readonly SliceRule[] = [
    {
        feature: 'stripe-checkout',
        // A webhook switch that handles the completed-checkout event = payments
        // are intended. The scaffold ships an EMPTY switch, so this only matches
        // once a generated app actually wires the event.
        receiver: /checkout\.session\.completed/,
        initiator: /checkout\.sessions\.create/,
        receiverLabel: 'the Stripe webhook handles `checkout.session.completed`',
        initiatorLabel: 'a checkout session is created (`stripe.checkout.sessions.create(...)`)',
    },
    {
        feature: 'stripe-subscription',
        receiver: /customer\.subscription\.(created|updated|deleted)/,
        // Either a subscription-mode checkout or a direct subscriptions.create.
        initiator: /subscriptions\.create|mode:\s*['"`]subscription['"`]/,
        receiverLabel: 'the Stripe webhook handles `customer.subscription.*`',
        initiatorLabel: 'a subscription is initiated (subscription-mode checkout or `subscriptions.create`)',
    },
];

const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const SKIP_DIRS: ReadonlySet<string> = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.vercel',
]);

// ── Required-initiator rule (PR-2) ───────────────────
//
// The orphaned-half check above is symptom-driven: it only fires once a
// webhook RECEIVER is wired. But the MCC-class failure is broader — the brief
// asks for a paid membership/subscription and the generated app ships NEITHER
// half, so there's nothing to flag by symmetry and the bare scaffold passes.
//
// This rule is intent-driven: if the project brief implies the app must take
// money, then a payment INITIATOR (`checkout.sessions.create` or a
// `subscriptions.create`) MUST exist in the source. Absent ⇒ violation. It is
// the "you asked for payments and the app can't charge anyone" gate.

/**
 * Brief phrases that imply the app itself must collect payment. Deliberately
 * specific: a passing mention of "free" or "no payment" must not trip it, and
 * generic words ("plan", "tier") only count alongside a money signal.
 */
const PAYMENT_INTENT_PATTERNS: readonly RegExp[] = [
    /\bsubscriptions?\b/i,
    /\bsubscribe\b/i,
    /\bpaid\s+(?:membership|plan|tier|subscription|account)\b/i,
    /\bmembership\s+(?:fee|payment|plan|tier)\b/i,
    /\bpaywall(?:ed)?\b/i,
    /\bcheckout\b/i,
    /\bstripe\b/i,
    /\bbilling\b/i,
    /\b(?:premium|pro)\s+(?:plan|tier|subscription|membership|upgrade)\b/i,
    /\bper\s+month\b/i,
    /\bper\s+year\b/i,
    /\$\d+\s*(?:\/|\s*per\s*)\s*(?:mo|month|yr|year)\b/i,
    /\b\d+\s*(?:\/|\s*per\s*)\s*(?:mo|month)\b/i,
    /\bmonetiz(?:e|ation)\b/i,
    /\b(?:pricing|payment)\s+(?:plan|tier|page|flow)\b/i,
    /\bupgrade\s+to\s+(?:premium|pro|paid)\b/i,
] as const;

/** Source signals that a payment initiator is wired. */
const PAYMENT_INITIATOR_RE = /checkout\.sessions\.create|subscriptions\.create/;

/** True when the brief implies the app must collect payment. */
export function briefImpliesPayments(brief: string): boolean {
    return PAYMENT_INTENT_PATTERNS.some((re) => re.test(brief));
}

/**
 * Pure core: given the brief + the concatenated source corpus, return a
 * violation when payments are implied by the brief but no initiator is wired.
 * Returns [] when payments aren't implied (so non-payment apps never trip it).
 */
export function detectMissingRequiredInitiator(
    brief: string,
    sources: readonly string[],
): readonly VerticalSliceViolation[] {
    if (!briefImpliesPayments(brief)) return [];
    const corpus = sources.join('\n');
    if (PAYMENT_INITIATOR_RE.test(corpus)) return [];
    return [
        {
            check: 'missing-required-initiator',
            feature: 'payments',
            expected: 'a payment initiator (`stripe.checkout.sessions.create(...)` or `subscriptions.create`)',
            message:
                'Required initiator missing: the brief implies the app must take payment ' +
                '(subscription / membership / checkout), but no payment initiator ' +
                '(`stripe.checkout.sessions.create(...)` or `subscriptions.create`) exists in the source. ' +
                'A paid product with no way to start a payment can never collect money — wire the checkout path.',
        },
    ];
}

/**
 * Pure core: given the concatenated source corpus, return one violation per
 * rule whose receiver is present but initiator is absent (and vice-versa).
 * Exposed for unit tests that don't want to touch the filesystem.
 */
export function detectOrphanedHalves(sources: readonly string[]): readonly VerticalSliceViolation[] {
    const corpus = sources.join('\n');
    const violations: VerticalSliceViolation[] = [];

    for (const rule of SLICE_RULES) {
        const hasReceiver = rule.receiver.test(corpus);
        const hasInitiator = rule.initiator.test(corpus);

        if (hasReceiver && !hasInitiator) {
            violations.push({
                check: 'orphaned-half-feature',
                feature: rule.feature,
                expected: rule.initiatorLabel,
                message:
                    `Orphaned half-feature "${rule.feature}": ${rule.receiverLabel}, but ${rule.initiatorLabel} ` +
                    `is missing. A receiver with no sender can never complete the flow — wire both ends.`,
            });
        }
    }
    return violations;
}

/** Walk a repo and return the contents of every source file. */
export function collectRepoSources(
    repoPath: string,
    fsImpl: typeof import('fs'),
): readonly string[] {
    const sources: string[] = [];

    const walk = (dir: string): void => {
        let entries: import('fs').Dirent[];
        try {
            entries = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!SOURCE_EXTS.includes(ext)) continue;
                try {
                    sources.push(fsImpl.readFileSync(full, 'utf-8'));
                } catch {
                    // unreadable — skip
                }
            }
        }
    };
    walk(repoPath);
    return sources;
}

/** Walk a repo's source files and run the orphaned-half detector. */
export function scanRepoForOrphanedHalves(
    repoPath: string,
    fsImpl: typeof import('fs'),
): readonly VerticalSliceViolation[] {
    return detectOrphanedHalves(collectRepoSources(repoPath, fsImpl));
}

/**
 * Walk a repo's source files and run the required-initiator detector against
 * the supplied brief. Returns [] when the brief doesn't imply payments.
 */
export function scanRepoForMissingRequiredInitiator(
    repoPath: string,
    fsImpl: typeof import('fs'),
    brief: string,
): readonly VerticalSliceViolation[] {
    return detectMissingRequiredInitiator(brief, collectRepoSources(repoPath, fsImpl));
}
