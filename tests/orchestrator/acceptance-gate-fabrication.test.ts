/**
 * AcceptanceGate × fabrication audit (PR-5) wiring + kill-switch.
 *
 * A generated app whose UI ships placeholder text must FAIL acceptance by
 * default even with preview 200, downgrade to advisory under `warn`, and be
 * skipped under `off`.
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

describe('AcceptanceGate × fabrication audit', () => {
    let gate: AcceptanceGate;
    let eventBus: ReturnType<typeof createMockEventBus>;
    let dir: string;
    const prev = process.env[GATE_ENV.fabrication];

    beforeEach(() => {
        eventBus = createMockEventBus();
        gate = new AcceptanceGate(eventBus as never);
        gate.setFetchOverrideForTests(mkFetchOk(200));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-fab-acc-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
        fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
        // Shipped UI with lorem-ipsum placeholder copy.
        fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default () => <p>Lorem ipsum dolor sit amet</p>;');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (prev === undefined) delete process.env[GATE_ENV.fabrication];
        else process.env[GATE_ENV.fabrication] = prev;
    });

    function run(): ReturnType<AcceptanceGate['verify']> {
        return gate.verify('proj-fab', dir, 'A members club', {
            kind: 'build-tests-preview',
            previewUrl: 'https://app.vercel.app',
            previewRoutes: [],
        });
    }

    it('blocks by default on placeholder copy even with preview 200', async () => {
        delete process.env[GATE_ENV.fabrication];
        const result = await run();
        expect(result.passed).toBe(false);
        const v = result.violations.find((x) => x.check === 'lorem-ipsum');
        expect(v?.severity).toBe('must');
    });

    it('warn mode downgrades to advisory and passes', async () => {
        process.env[GATE_ENV.fabrication] = 'warn';
        const result = await run();
        const v = result.violations.find((x) => x.check === 'lorem-ipsum');
        expect(v?.severity).toBe('should');
        expect(result.passed).toBe(true);
    });

    it('off mode skips the audit', async () => {
        process.env[GATE_ENV.fabrication] = 'off';
        const result = await run();
        expect(result.violations.find((x) => x.check === 'lorem-ipsum')).toBeUndefined();
    });
});
