/**
 * AcceptanceGate × required-initiator (PR-2) wiring.
 *
 * Proves the brief-aware required-initiator rule is wired into
 * verifyBuildTestsPreview and honours the KAGEOPS_GATE_REQUIRED_INITIATOR
 * kill-switch: block ⇒ MUST (fails the gate), warn ⇒ SHOULD (advisory, passes),
 * off ⇒ skipped — even though the preview URL returns 200 throughout.
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

const PAYMENTS_BRIEF = 'A paid subscription membership app — members pay $9/month for premium content.';

describe('AcceptanceGate × required-initiator', () => {
    let gate: AcceptanceGate;
    let eventBus: ReturnType<typeof createMockEventBus>;
    let dir: string;
    const prev = process.env[GATE_ENV.requiredInitiator];

    beforeEach(() => {
        eventBus = createMockEventBus();
        gate = new AcceptanceGate(eventBus as never);
        gate.setFetchOverrideForTests(mkFetchOk(200));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-ri-'));
        // Real code app whose payment slice is NOT wired (no initiator).
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
        fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default () => null;');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (prev === undefined) delete process.env[GATE_ENV.requiredInitiator];
        else process.env[GATE_ENV.requiredInitiator] = prev;
    });

    function run(): ReturnType<AcceptanceGate['verify']> {
        return gate.verify('proj-ri', dir, PAYMENTS_BRIEF, {
            kind: 'build-tests-preview',
            previewUrl: 'https://app.vercel.app',
            previewRoutes: [],
        });
    }

    it('blocks by default: a payments brief with no initiator fails even with preview 200', async () => {
        delete process.env[GATE_ENV.requiredInitiator];
        const result = await run();
        expect(result.passed).toBe(false);
        const v = result.violations.find((x) => x.check === 'missing-required-initiator');
        expect(v).toBeDefined();
        expect(v?.severity).toBe('must');
    });

    it('warn mode downgrades it to an advisory SHOULD and the gate passes', async () => {
        process.env[GATE_ENV.requiredInitiator] = 'warn';
        const result = await run();
        expect(result.passed).toBe(true);
        const v = result.violations.find((x) => x.check === 'missing-required-initiator');
        expect(v?.severity).toBe('should');
    });

    it('off mode skips the check entirely', async () => {
        process.env[GATE_ENV.requiredInitiator] = 'off';
        const result = await run();
        expect(result.violations.find((x) => x.check === 'missing-required-initiator')).toBeUndefined();
        expect(result.passed).toBe(true);
    });

    it('passes when an initiator is wired, regardless of mode', async () => {
        delete process.env[GATE_ENV.requiredInitiator];
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'checkout.ts'),
            `export const buy = () => getStripe().checkout.sessions.create({ mode: 'subscription' });`,
        );
        const result = await run();
        expect(result.violations.find((x) => x.check === 'missing-required-initiator')).toBeUndefined();
        expect(result.passed).toBe(true);
    });
});
