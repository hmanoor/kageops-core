/**
 * AcceptanceGate G3 wiring — orphaned half-feature blocks build-tests-preview.
 *
 * Proves the vertical-slice check is wired into verifyBuildTestsPreview: a
 * generated app whose preview URL returns 200 but whose payment flow is wired
 * on only one end must FAIL acceptance, and a fully-wired app must pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockEventBus } from '../helpers/mock-event-bus';

import { AcceptanceGate } from '../../src/orchestrator/acceptance-gate';

function mkFetchOk(status: number): typeof globalThis.fetch {
    return vi.fn(async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
}

describe('AcceptanceGate G3 — orphaned half-feature', () => {
    let gate: AcceptanceGate;
    let eventBus: ReturnType<typeof createMockEventBus>;
    let dir: string;

    beforeEach(() => {
        eventBus = createMockEventBus();
        gate = new AcceptanceGate(eventBus as never);
        gate.setFetchOverrideForTests(mkFetchOk(200));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-g3-'));
        // Real code app: package.json present so the slice scan runs.
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
        fs.mkdirSync(path.join(dir, 'app', 'api', 'stripe', 'webhook'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fails when a checkout webhook receiver has no checkout initiator, even with preview 200', async () => {
        fs.writeFileSync(
            path.join(dir, 'app', 'api', 'stripe', 'webhook', 'route.ts'),
            `case 'checkout.session.completed': await activate(); break;`,
        );

        const result = await gate.verify('proj-g3', dir, 'unused', {
            kind: 'build-tests-preview',
            previewUrl: 'https://app.vercel.app',
            previewRoutes: [],
        });

        expect(result.passed).toBe(false);
        const orphan = result.violations.find((v) => v.check === 'orphaned-half-feature');
        expect(orphan).toBeDefined();
        expect(orphan?.severity).toBe('must');
        expect(result.reason).toContain('functional-completeness violation');
        expect(eventBus.publish).toHaveBeenCalledWith(
            'acceptance.failed',
            expect.objectContaining({ projectId: 'proj-g3' }),
        );
    });

    it('passes when both halves are wired and the preview URL is 200', async () => {
        // Integrity-clean slice: signature-verified webhook, user-keyed
        // activation, env-driven price (so payment-integrity also passes).
        fs.writeFileSync(
            path.join(dir, 'app', 'api', 'stripe', 'webhook', 'route.ts'),
            `const event = getStripe().webhooks.constructEvent(body, sig, secret);\n` +
            `if (event.type === 'checkout.session.completed') { const id = event.data.object.metadata.clerkId; await activate(id); }`,
        );
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'checkout.ts'),
            `export const buy = () => getStripe().checkout.sessions.create({ mode: 'subscription', metadata: { clerkId }, line_items: [{ price: process.env.STRIPE_PRICE_ID }] });`,
        );

        const result = await gate.verify('proj-g3', dir, 'unused', {
            kind: 'build-tests-preview',
            previewUrl: 'https://app.vercel.app',
            previewRoutes: [],
        });

        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
    });
});
