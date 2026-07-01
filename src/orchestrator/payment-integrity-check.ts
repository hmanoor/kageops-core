/**
 * Payment-integrity check (PR-3) — the money path stays wired CORRECTLY.
 *
 * The required-initiator rule (vertical-slice-check.ts) proves a payment
 * initiator EXISTS. This goes a layer deeper: when payments are wired, are they
 * wired in a way that actually grants access to the right user and can't be
 * forged? These are the invariants the scaffold ships and that a Forge
 * customization can silently break while still "looking done":
 *
 *   1. webhook-no-signature-verify — a Stripe webhook receiver exists but the
 *      event is not verified with `webhooks.constructEvent(...)`. Parsing the
 *      raw body as JSON trusts a spoofable request — anyone can POST a fake
 *      `checkout.session.completed` and unlock the app for free.
 *   2. hardcoded-price — a literal Stripe price id (`price_…`) is embedded in
 *      source instead of read from env. It breaks across environments and
 *      leaks the id; the scaffold reads `STRIPE_PRICE_ID`.
 *   3. activation-not-keyed-to-user — the `checkout.session.completed` handler
 *      doesn't read `metadata`/`client_reference_id`, so it can't tie the paid
 *      session back to the Clerk user. Access is then granted to nobody (or the
 *      wrong row).
 *
 * Each fires ONLY when payments are actually wired (an initiator is present),
 * so non-payment apps and the inert parts of the scaffold never trip it. Pure
 * over source strings; fs injected for the repo walk.
 */

import { collectRepoSources } from './vertical-slice-check';

export type PaymentIntegrityCheck =
    | 'webhook-no-signature-verify'
    | 'hardcoded-price'
    | 'activation-not-keyed-to-user';

export interface PaymentIntegrityViolation {
    readonly check: PaymentIntegrityCheck;
    readonly expected: string;
    readonly message: string;
}

// Payments are "wired" once a checkout/subscription initiator exists.
const INITIATOR_RE = /checkout\.sessions\.create|subscriptions\.create/;
// A Stripe webhook receiver is present once it handles a Stripe event or reads
// the signature header.
const WEBHOOK_RECEIVER_RE = /checkout\.session\.completed|customer\.subscription\.|stripe-signature/i;
// Signature verification — the only safe way to trust an inbound Stripe event.
const CONSTRUCT_EVENT_RE = /\.constructEvent(?:Async)?\s*\(|constructEventAsync\s*\(/;
// A real Stripe price id is `price_` + ~24 url-safe chars. Require >= 16 to
// avoid matching placeholders like `price_123` or `price_xxx` in comments/docs.
const HARDCODED_PRICE_RE = /['"`]price_[A-Za-z0-9]{16,}['"`]/;
// The completed-checkout handler must derive the user from the session.
const USER_KEYING_RE = /metadata|client_reference_id/;

/**
 * Pure core: given the concatenated source corpus, return integrity violations.
 * Returns [] when payments aren't wired (no initiator) so it's a strict
 * superset-guard on top of required-initiator, never a duplicate signal.
 */
export function detectPaymentIntegrityIssues(
    sources: readonly string[],
): readonly PaymentIntegrityViolation[] {
    const corpus = sources.join('\n');
    if (!INITIATOR_RE.test(corpus)) return [];

    const violations: PaymentIntegrityViolation[] = [];

    const hasWebhookReceiver = WEBHOOK_RECEIVER_RE.test(corpus);
    if (hasWebhookReceiver && !CONSTRUCT_EVENT_RE.test(corpus)) {
        violations.push({
            check: 'webhook-no-signature-verify',
            expected: 'getStripe().webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)',
            message:
                'Payment webhook does not verify the Stripe signature: no `webhooks.constructEvent(...)` ' +
                'call found. Parsing the request body directly trusts a spoofable POST — anyone could ' +
                'forge `checkout.session.completed` and unlock the app for free. Verify every inbound ' +
                'event with `getStripe().webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)` ' +
                'before acting on it.',
        });
    }

    const priceMatch = corpus.match(HARDCODED_PRICE_RE);
    if (priceMatch !== null) {
        violations.push({
            check: 'hardcoded-price',
            expected: 'process.env.STRIPE_PRICE_ID',
            message:
                `A Stripe price id is hardcoded in source (\`${priceMatch[0].replace(/['"`]/g, '')}\`). ` +
                'Price ids differ per environment and must not be committed — read the price from ' +
                '`process.env.STRIPE_PRICE_ID` (as the scaffold does) and remove the literal.',
        });
    }

    // Only meaningful when a completed-checkout handler exists. Check the lines
    // around each handler for a user-keying reference.
    if (/checkout\.session\.completed/.test(corpus) && !USER_KEYING_RE.test(corpus)) {
        violations.push({
            check: 'activation-not-keyed-to-user',
            expected: 'session.metadata?.clerkId ?? session.client_reference_id',
            message:
                'The `checkout.session.completed` handler does not read `metadata` or ' +
                '`client_reference_id`, so it cannot tie the paid session back to the user who paid. ' +
                'Set `metadata: { clerkId }` (and/or `client_reference_id`) when creating the checkout ' +
                'session, and read it in the handler to activate the correct membership row.',
        });
    }

    return violations;
}

/** Walk a repo's source files and run the payment-integrity detector. */
export function scanRepoForPaymentIntegrity(
    repoPath: string,
    fsImpl: typeof import('fs'),
): readonly PaymentIntegrityViolation[] {
    return detectPaymentIntegrityIssues(collectRepoSources(repoPath, fsImpl));
}
