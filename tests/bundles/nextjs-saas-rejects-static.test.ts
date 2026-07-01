/**
 * BPF-39 — nextjs-saas must NOT be selected for a brief that explicitly
 * disclaims auth / database / backend / payments. Those briefs would otherwise
 * inherit the SaaS scaffold's Stripe checkout+webhook, which the payment-
 * integrity acceptance check then (correctly) flags on an app that never wanted
 * payments — the Prism mismatch that jammed its build gate.
 *
 * Loads the REAL bundle manifests (not synthetic fixtures) so the assertion is
 * over the shipped rejectPhrases.
 */

import { describe, it, expect } from 'vitest';
import { loadBundles } from '../../src/bundles/bundle-loader';
import { BundleRegistry } from '../../src/bundles/bundle-registry';
import { matchBundleForBrief } from '../../src/bundles/bundle-matcher';

async function realRegistry(): Promise<BundleRegistry> {
    const { bundles, errors } = await loadBundles();
    return new BundleRegistry({ bundles, errors });
}

describe('BPF-39: nextjs-saas reject-phrases for static / no-backend briefs', () => {
    it('a fully-client-side, no-auth/no-db/no-backend brief does NOT match nextjs-saas', async () => {
        const registry = await realRegistry();
        const brief =
            'Prism — a beautiful interactive design toolkit for developers. ' +
            'Next.js App Router + TypeScript + Tailwind. NO sign-in, NO database, ' +
            'NO backend. Fully client-side. Zero accounts.';
        const hit = matchBundleForBrief({ text: brief, registry });
        expect(hit?.bundle.manifest.name).not.toBe('nextjs-saas');
    });

    it('a real SaaS brief (auth + subscriptions + database) STILL matches nextjs-saas', async () => {
        const registry = await realRegistry();
        const brief =
            'A Next.js SaaS app with Clerk authentication, Stripe subscriptions, ' +
            'a Neon database, a members dashboard, and a pricing page.';
        const hit = matchBundleForBrief({ text: brief, registry });
        expect(hit?.bundle.manifest.name).toBe('nextjs-saas');
    });
});
