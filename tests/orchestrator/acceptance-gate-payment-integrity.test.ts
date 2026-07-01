/**
 * AcceptanceGate × payment-integrity (PR-3) wiring + kill-switch.
 *
 * A generated app whose payment flow is wired but UNSAFE (webhook doesn't
 * verify the signature) must FAIL acceptance by default even with preview 200,
 * be downgraded to advisory under `warn`, and skipped under `off`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockEventBus } from '../helpers/mock-event-bus';

import { AcceptanceGate } from '../../src/orchestrator/acceptance-gate';
import { GATE_ENV } from '../../src/orchestrator/gate-modes';

function mkFetchOk(status: number): typeof globalThis.fetch {
    return vi.fn(async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
}

describe('AcceptanceGate × payment-integrity', () => {
    let gate: AcceptanceGate;
    let eventBus: ReturnType<typeof createMockEventBus>;
    let dir: string;
    const prev = process.env[GATE_ENV.paymentIntegrity];

    beforeEach(() => {
        eventBus = createMockEventBus();
        gate = new AcceptanceGate(eventBus as never);
        gate.setFetchOverrideForTests(mkFetchOk(200));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-pi-acc-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
        // Payments wired (initiator present) but the webhook is UNVERIFIED.
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'checkout.ts'),
            `export const buy = () => getStripe().checkout.sessions.create({ mode: 'subscription', metadata: { clerkId } });`,
        );
        fs.mkdirSync(path.join(dir, 'app', 'api', 'stripe', 'webhook'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'app', 'api', 'stripe', 'webhook', 'route.ts'),
            `const event = JSON.parse(await req.text());\nif (event.type === 'checkout.session.completed') { event.data.object.metadata.clerkId; }`,
        );
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (prev === undefined) delete process.env[GATE_ENV.paymentIntegrity];
        else process.env[GATE_ENV.paymentIntegrity] = prev;
    });

    function run(): ReturnType<AcceptanceGate['verify']> {
        return gate.verify('proj-pi', dir, 'A paid subscription app', {
            kind: 'build-tests-preview',
            previewUrl: 'https://app.vercel.app',
            previewRoutes: [],
        });
    }

    it('blocks by default on an unverified webhook even with preview 200', async () => {
        delete process.env[GATE_ENV.paymentIntegrity];
        const result = await run();
        expect(result.passed).toBe(false);
        const v = result.violations.find((x) => x.check === 'webhook-no-signature-verify');
        expect(v?.severity).toBe('must');
    });

    it('warn mode downgrades to advisory and passes', async () => {
        process.env[GATE_ENV.paymentIntegrity] = 'warn';
        const result = await run();
        const v = result.violations.find((x) => x.check === 'webhook-no-signature-verify');
        expect(v?.severity).toBe('should');
        expect(result.passed).toBe(true);
    });

    it('off mode skips the check', async () => {
        process.env[GATE_ENV.paymentIntegrity] = 'off';
        const result = await run();
        expect(result.violations.find((x) => x.check === 'webhook-no-signature-verify')).toBeUndefined();
    });
});
