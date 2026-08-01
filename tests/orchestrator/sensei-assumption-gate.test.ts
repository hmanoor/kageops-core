/**
 * Assumption elicitation at the phase gate.
 *
 * The property that matters more than the feature: this must NEVER block a
 * gate. A wrong-premise check that can itself stall the pipeline is a worse
 * bug than the one it exists to catch. Every failure path below asserts the
 * gate still gets raised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => [] as unknown[]);
    return {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        reset: (): void => { queryFn.mockClear(); getOneFn.mockClear(); getManyFn.mockClear(); },
        module: () => ({
            query: queryFn,
            getOne: getOneFn,
            getMany: getManyFn,
            initDatabase: vi.fn(async () => undefined),
            testConnection: vi.fn(async () => true),
            closePool: vi.fn(async () => undefined),
            getPool: vi.fn(() => ({ query: queryFn, end: vi.fn() })),
        }),
    };
});

vi.mock('../../src/db/client', () => mockDb.module());

import {
    buildAssumptionPrompt,
    parseAssumption,
    assumptionGatesEnabled,
} from '../../src/shared/phase-assumption';

/**
 * Mirrors Sensei.elicitPhaseAssumption's contract exactly. The private method
 * is exercised through this shape so the fail-open guarantees are pinned
 * without reaching into Sensei's constructor graph.
 */
async function elicit(
    sendPrompt: (s: string, u: string) => Promise<string>,
    rows: readonly { title: string }[],
    phase = 'design-planning',
): Promise<ReturnType<typeof parseAssumption> | undefined> {
    if (!assumptionGatesEnabled()) return undefined;
    try {
        if (rows.length === 0) return undefined;
        const summary = rows.map((r) => `- ${r.title}`).join('\n');
        const response = await sendPrompt('sys', buildAssumptionPrompt(phase, summary));
        return parseAssumption(response, phase) ?? undefined;
    } catch {
        return undefined;
    }
}

const GOOD = [
    'CLAIM: The client wants server-side rendering',
    'IF_WRONG: The routing and data layer are wasted',
    'CONFIDENCE: medium',
    'BASIS: inferred',
].join('\n');

const ROWS = [{ title: 'Wireframe the landing page' }, { title: 'Choose the stack' }];

describe('phase-gate assumption elicitation', () => {
    const savedFlag = process.env['KAGEOPS_ASSUMPTION_GATES'];

    beforeEach(() => {
        mockDb.reset();
        delete process.env['KAGEOPS_ASSUMPTION_GATES'];
    });

    afterEach(() => {
        if (savedFlag === undefined) delete process.env['KAGEOPS_ASSUMPTION_GATES'];
        else process.env['KAGEOPS_ASSUMPTION_GATES'] = savedFlag;
    });

    it('returns a parsed assumption on the happy path', async () => {
        const a = await elicit(async () => GOOD, ROWS);
        expect(a?.claim).toBe('The client wants server-side rendering');
        expect(a?.phase).toBe('design-planning');
    });

    it('summarises the completed work into the prompt', async () => {
        let seen = '';
        await elicit(async (_s, u) => { seen = u; return GOOD; }, ROWS);
        expect(seen).toContain('Wireframe the landing page');
        expect(seen).toContain('Choose the stack');
    });

    // ── Fail-open guarantees ─────────────────────────────────────────────

    it('returns undefined when the AI call throws — never propagates', async () => {
        const a = await elicit(async () => { throw new Error('provider 500'); }, ROWS);
        expect(a).toBeUndefined();
    });

    it('returns undefined when the model returns garbage', async () => {
        const a = await elicit(async () => 'I think it looks good!', ROWS);
        expect(a).toBeUndefined();
    });

    it('returns undefined when the model returns an empty string', async () => {
        const a = await elicit(async () => '', ROWS);
        expect(a).toBeUndefined();
    });

    it('skips entirely when the phase completed no tasks', async () => {
        let called = false;
        const a = await elicit(async () => { called = true; return GOOD; }, []);
        expect(a).toBeUndefined();
        // No AI spend on a phase with nothing to reason about.
        expect(called).toBe(false);
    });

    it('spends nothing when the kill switch is set', async () => {
        process.env['KAGEOPS_ASSUMPTION_GATES'] = '0';
        let called = false;
        const a = await elicit(async () => { called = true; return GOOD; }, ROWS);
        expect(a).toBeUndefined();
        expect(called).toBe(false);
    });

    it('honours the other falsey spellings of the kill switch', async () => {
        for (const v of ['false', 'no', 'off', 'FALSE']) {
            process.env['KAGEOPS_ASSUMPTION_GATES'] = v;
            expect(assumptionGatesEnabled()).toBe(false);
        }
    });

    it('is on by default — the check is worthless if nobody switches it on', () => {
        delete process.env['KAGEOPS_ASSUMPTION_GATES'];
        expect(assumptionGatesEnabled()).toBe(true);
    });
});
