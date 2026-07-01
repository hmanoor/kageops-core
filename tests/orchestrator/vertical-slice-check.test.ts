/**
 * Vertical-slice (functional-completeness) check tests — G3.
 *
 * The MCC build shipped a Stripe webhook receiver with no checkout-session
 * initiator — a flow wired on one end that could never complete. These tests
 * lock in detection of that and the symmetric "sender with no receiver".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    detectOrphanedHalves,
    scanRepoForOrphanedHalves,
    briefImpliesPayments,
    detectMissingRequiredInitiator,
    scanRepoForMissingRequiredInitiator,
} from '../../src/orchestrator/vertical-slice-check';

describe('detectOrphanedHalves()', () => {
    it('flags a checkout webhook receiver with no checkout initiator (the MCC defect)', () => {
        const sources = [
            `switch (event.type) { case 'checkout.session.completed': await activate(); break; }`,
        ];
        const v = detectOrphanedHalves(sources);
        expect(v).toHaveLength(1);
        expect(v[0].feature).toBe('stripe-checkout');
        expect(v[0].message).toContain('checkout.sessions.create');
    });

    it('passes when both halves are wired', () => {
        const sources = [
            `case 'checkout.session.completed': await activate(); break;`,
            `const session = await getStripe().checkout.sessions.create({ mode: 'payment' });`,
        ];
        expect(detectOrphanedHalves(sources)).toHaveLength(0);
    });

    it('does NOT flag an initiator with no receiver (redirect-confirm flows are valid)', () => {
        const sources = [
            `const session = await stripe.checkout.sessions.create({ mode: 'payment', success_url });`,
        ];
        expect(detectOrphanedHalves(sources)).toHaveLength(0);
    });

    it('does not fire on the bare scaffold (empty switch, no checkout literals)', () => {
        const sources = [
            `switch (event.type) { default: break; }`,
            `export function getStripe() { return new Stripe(process.env.K!); }`,
        ];
        expect(detectOrphanedHalves(sources)).toHaveLength(0);
    });

    it('flags a subscription webhook receiver with no subscription initiator', () => {
        const sources = [`case 'customer.subscription.updated': await sync(); break;`];
        const v = detectOrphanedHalves(sources);
        expect(v).toHaveLength(1);
        expect(v[0].feature).toBe('stripe-subscription');
    });

    it('accepts a subscription-mode checkout as the subscription initiator', () => {
        const sources = [
            `case 'customer.subscription.created': await sync(); break;`,
            `await getStripe().checkout.sessions.create({ mode: 'subscription' });`,
        ];
        expect(detectOrphanedHalves(sources)).toHaveLength(0);
    });
});

describe('scanRepoForOrphanedHalves()', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-slice-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('flags a repo whose webhook handles checkout but nothing creates a session', () => {
        fs.mkdirSync(path.join(dir, 'app', 'api', 'stripe', 'webhook'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'app', 'api', 'stripe', 'webhook', 'route.ts'),
            `switch (event.type) { case 'checkout.session.completed': break; }`,
        );
        const v = scanRepoForOrphanedHalves(dir, fs);
        expect(v).toHaveLength(1);
        expect(v[0].feature).toBe('stripe-checkout');
    });

    it('passes once an initiator file is added elsewhere in the repo', () => {
        fs.mkdirSync(path.join(dir, 'app', 'api', 'stripe', 'webhook'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'app', 'api', 'stripe', 'webhook', 'route.ts'),
            `case 'checkout.session.completed': break;`,
        );
        fs.mkdirSync(path.join(dir, 'lib', 'actions'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'actions', 'checkout.ts'),
            `export async function buy() { return getStripe().checkout.sessions.create({}); }`,
        );
        expect(scanRepoForOrphanedHalves(dir, fs)).toHaveLength(0);
    });
});

describe('briefImpliesPayments()', () => {
    it('fires on explicit money signals', () => {
        for (const brief of [
            'A subscription app for premium recipes',
            'Members pay $9/month for access',
            'Add a Stripe checkout for the paid plan',
            'Build a paywalled newsletter',
            'Premium tier with monthly billing',
            'Let users subscribe to the pro plan',
        ]) {
            expect(briefImpliesPayments(brief), brief).toBe(true);
        }
    });

    it('does NOT fire on free / non-payment briefs', () => {
        for (const brief of [
            'A free to-do list app',
            'A public landing page with no signup',
            'A blog where anyone can read articles',
            'An internal dashboard for the team',
        ]) {
            expect(briefImpliesPayments(brief), brief).toBe(false);
        }
    });
});

describe('detectMissingRequiredInitiator()', () => {
    it('flags a payments brief whose source has no initiator (the broader MCC failure)', () => {
        const v = detectMissingRequiredInitiator('A subscription membership app', [
            `export default function Page() { return <div>Members</div>; }`,
        ]);
        expect(v).toHaveLength(1);
        expect(v[0].check).toBe('missing-required-initiator');
        expect(v[0].feature).toBe('payments');
    });

    it('passes when the brief implies payments AND an initiator exists', () => {
        const v = detectMissingRequiredInitiator('A subscription membership app', [
            `await getStripe().checkout.sessions.create({ mode: 'subscription' });`,
        ]);
        expect(v).toHaveLength(0);
    });

    it('accepts a direct subscriptions.create as the initiator', () => {
        const v = detectMissingRequiredInitiator('Premium monthly plan', [
            `await stripe.subscriptions.create({ customer, items });`,
        ]);
        expect(v).toHaveLength(0);
    });

    it('is a no-op when the brief does not imply payments (even with no initiator)', () => {
        const v = detectMissingRequiredInitiator('A free to-do list', [
            `export default function Page() { return <ul/>; }`,
        ]);
        expect(v).toHaveLength(0);
    });
});

describe('scanRepoForMissingRequiredInitiator()', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-init-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('flags a payments-brief repo with no checkout initiator anywhere', () => {
        fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), `export default () => <div/>;`);
        const v = scanRepoForMissingRequiredInitiator(dir, fs, 'A paid subscription app');
        expect(v).toHaveLength(1);
        expect(v[0].check).toBe('missing-required-initiator');
    });

    it('passes once a checkout initiator exists in the repo', () => {
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'checkout.ts'),
            `export const buy = () => getStripe().checkout.sessions.create({ mode: 'subscription' });`,
        );
        expect(scanRepoForMissingRequiredInitiator(dir, fs, 'A paid subscription app')).toHaveLength(0);
    });
});
