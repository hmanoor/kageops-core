/**
 * Payment-integrity check (PR-3) — the money path stays wired correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    detectPaymentIntegrityIssues,
    scanRepoForPaymentIntegrity,
} from '../../src/orchestrator/payment-integrity-check';

const INITIATOR = `await getStripe().checkout.sessions.create({ mode: 'subscription' });`;

describe('detectPaymentIntegrityIssues()', () => {
    it('is a no-op when no payment initiator is wired', () => {
        expect(detectPaymentIntegrityIssues([`export default () => null;`])).toEqual([]);
    });

    it('passes the correctly-wired scaffold shape', () => {
        const sources = [
            INITIATOR,
            `metadata: { clerkId }, client_reference_id: clerkId,`,
            `case 'checkout.session.completed': { const clerkId = session.metadata?.clerkId ?? session.client_reference_id; }`,
            `event = getStripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);`,
            `line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }]`,
        ];
        expect(detectPaymentIntegrityIssues(sources)).toEqual([]);
    });

    it('flags a webhook receiver that does not verify the signature', () => {
        const sources = [
            INITIATOR,
            `const event = JSON.parse(rawBody);\nif (event.type === 'checkout.session.completed') { const clerkId = event.data.object.metadata.clerkId; }`,
        ];
        const v = detectPaymentIntegrityIssues(sources);
        expect(v.map((x) => x.check)).toContain('webhook-no-signature-verify');
    });

    it('flags a hardcoded Stripe price id', () => {
        const sources = [
            INITIATOR,
            `metadata: { clerkId },`,
            `const event = getStripe().webhooks.constructEvent(b, s, sec);`,
            `case 'checkout.session.completed': session.metadata;`,
            `line_items: [{ price: 'price_1QabcdEFgh23ijklMNOPqrst', quantity: 1 }]`,
        ];
        const v = detectPaymentIntegrityIssues(sources);
        expect(v.map((x) => x.check)).toContain('hardcoded-price');
    });

    it('does NOT flag a short placeholder price id', () => {
        const sources = [INITIATOR, `// example: price_123`, `price: process.env.STRIPE_PRICE_ID`,
            `constructEvent(b,s,sec)`, `checkout.session.completed`, `metadata`];
        expect(detectPaymentIntegrityIssues(sources).map((x) => x.check)).not.toContain('hardcoded-price');
    });

    it('flags a completed-checkout handler that never keys activation to the user', () => {
        const sources = [
            INITIATOR,
            `event = getStripe().webhooks.constructEvent(b, s, sec);`,
            `case 'checkout.session.completed': await activateEveryone(); break;`,
            `line_items: [{ price: process.env.STRIPE_PRICE_ID }]`,
        ];
        const v = detectPaymentIntegrityIssues(sources);
        expect(v.map((x) => x.check)).toContain('activation-not-keyed-to-user');
    });
});

describe('scanRepoForPaymentIntegrity()', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-pi-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('flags an unverified webhook across files', () => {
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'lib', 'checkout.ts'), INITIATOR);
        fs.mkdirSync(path.join(dir, 'app', 'api', 'stripe', 'webhook'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'app', 'api', 'stripe', 'webhook', 'route.ts'),
            `const event = JSON.parse(await req.text());\nif (event.type === 'checkout.session.completed') { event.data.object.metadata; }`,
        );
        const v = scanRepoForPaymentIntegrity(dir, fs);
        expect(v.map((x) => x.check)).toContain('webhook-no-signature-verify');
    });
});

describe('the shipped scaffold passes payment-integrity', () => {
    it('has no integrity violations', () => {
        const scaffold = path.resolve(__dirname, '..', '..', 'bundles', 'stacks', 'nextjs-saas', 'scaffold');
        expect(scanRepoForPaymentIntegrity(scaffold, fs)).toEqual([]);
    });
});
