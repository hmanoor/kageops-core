/**
 * AcceptanceGate tests
 *
 * Mocks fs to simulate produced artifacts and verifies the gate fails on
 * spec-fidelity violations (missing IDs, missing artifact).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => ''),
    };
});

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
        warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(),
    }),
}));

import * as fs from 'fs';
import {
    AcceptanceGate,
    extractRequiredIds,
    extractHtmlIds,
} from '../../src/orchestrator/acceptance-gate';
import type { MockEventBus } from '../helpers/mock-event-bus';
import type { EventBus } from '../../src/orchestrator/event-bus';

describe('extractRequiredIds', () => {
    it('extracts double-quoted IDs', () => {
        const ids = extractRequiredIds('<h1 id="count">0</h1>');
        expect(ids).toContain('count');
    });

    it('extracts single-quoted IDs', () => {
        const ids = extractRequiredIds("button id='increment'");
        expect(ids).toContain('increment');
    });

    it('extracts unquoted IDs inside a tag context', () => {
        const ids = extractRequiredIds('<button id=increment>+</button>');
        expect(ids).toContain('increment');
    });

    it('does NOT extract unquoted IDs from plain prose (tag context required)', () => {
        // Prevents matching English like "the page id=important should..."
        const ids = extractRequiredIds('button id=increment that adds 1');
        expect(ids).not.toContain('increment');
    });

    it('extracts multiple distinct IDs from a realistic spec', () => {
        const desc = 'Simple counter: <h1 id="count">0</h1> and <button id=increment>+</button>';
        const ids = extractRequiredIds(desc);
        expect(ids).toEqual(expect.arrayContaining(['count', 'increment']));
    });

    it('deduplicates', () => {
        const ids = extractRequiredIds('id="x" and id="x" again');
        expect(ids.filter((id) => id === 'x')).toHaveLength(1);
    });

    it('returns empty array when spec has no id references', () => {
        const ids = extractRequiredIds('build me a website that looks nice');
        expect(ids).toEqual([]);
    });

    it('does not extract pseudo-matches like "id" inside words', () => {
        const ids = extractRequiredIds('the kid=happy avoid this');
        expect(ids).not.toContain('happy');
    });
});

describe('extractHtmlIds', () => {
    it('finds IDs in produced HTML', () => {
        const html = '<h1 id="count">0</h1><button id="increment">+</button>';
        expect(extractHtmlIds(html)).toEqual(expect.arrayContaining(['count', 'increment']));
    });

    it('handles single-quoted IDs in HTML', () => {
        const html = "<span id='foo'>x</span>";
        expect(extractHtmlIds(html)).toContain('foo');
    });

    it('returns empty for HTML with no IDs', () => {
        expect(extractHtmlIds('<div><p>hi</p></div>')).toEqual([]);
    });
});

describe('AcceptanceGate.verify', () => {
    let eventBus: MockEventBus;
    let gate: AcceptanceGate;

    beforeEach(() => {
        eventBus = createMockEventBus();
        gate = new AcceptanceGate(eventBus as unknown as EventBus);
        vi.mocked(fs.existsSync).mockReset();
        vi.mocked(fs.readFileSync).mockReset();
        // Default: test-cases.json does not exist (so readFileSync is only
        // called for index.html). Individual tests override as needed.
        vi.mocked(fs.existsSync).mockImplementation(
            (p) => !String(p).endsWith('test-cases.json')
        );
    });

    it('passes when artifact contains every required ID', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue(
            '<h1 id="count">0</h1><button id="increment">+</button>'
        );

        const result = await gate.verify(
            'proj-1',
            '/repo',
            'counter with <h1 id="count"> and <button id=increment>'
        );

        expect(result.passed).toBe(true);
        expect(result.skipped).toBe(false);
        expect(result.violations).toHaveLength(0);
        expect(eventBus.publishedEvents.find((e) => e.channel === 'acceptance.passed')).toBeDefined();
    });

    it('fails when an expected ID is missing from the artifact', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue(
            '<span id="counter-value">0</span><button id="increment-btn">+</button>'
        );

        const result = await gate.verify(
            'proj-2',
            '/repo',
            'counter with <h1 id="count"> and <button id=increment>'
        );

        expect(result.passed).toBe(false);
        expect(result.violations).toHaveLength(2);
        const missingIds = result.violations
            .filter((v) => v.check === 'missing-id')
            .map((v) => v.expected)
            .sort();
        expect(missingIds).toEqual([`<... id="count">`, `<... id="increment">`]);

        const failEvent = eventBus.publishedEvents.find((e) => e.channel === 'acceptance.failed');
        expect(failEvent).toBeDefined();
        expect(failEvent!.event.data.violations).toHaveLength(2);
    });

    it('fails when index.html is missing entirely', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const result = await gate.verify(
            'proj-3',
            '/repo',
            'counter with id="count"'
        );

        expect(result.passed).toBe(false);
        expect(result.violations[0].check).toBe('missing-artifact');
    });

    it('skips when spec has no testable assertions', async () => {
        const result = await gate.verify(
            'proj-4',
            '/repo',
            'build a nice todo app, make it look good'
        );

        expect(result.passed).toBe(true);
        expect(result.skipped).toBe(true);
        expect(eventBus.publishedEvents.find((e) => e.channel === 'acceptance.passed')).toBeDefined();
    });

    it('reproduces the V12 regression: spec says id=count, artifact has id=counter-value', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue(
            '<span id="counter-value">0</span><button id="increment-btn">+</button>'
        );

        const result = await gate.verify(
            'proj-v12',
            '/repo',
            'Simple web counter: index.html with <h1 id="count">0</h1> and <button id=increment>'
        );

        expect(result.passed).toBe(false);
        const missingIds = result.violations
            .filter((v) => v.check === 'missing-id')
            .map((v) => v.expected)
            .sort();
        expect(missingIds).toEqual([`<... id="count">`, `<... id="increment">`]);
    });

    function mockIndexOnly(html: string): void {
        vi.mocked(fs.readFileSync).mockReturnValue(html);
    }

    it('fails when spec requires a tag that is absent', async () => {
        mockIndexOnly('<div>hello</div>');

        const result = await gate.verify('p', '/repo', 'needs a `<button>` element');

        expect(result.passed).toBe(false);
        expect(result.violations[0].check).toBe('missing-tag');
    });

    it('fails when spec requires a class token that is absent', async () => {
        mockIndexOnly('<a class="secondary">x</a>');

        const result = await gate.verify('p', '/repo', 'style with `.primary`');

        expect(result.passed).toBe(false);
        expect(result.violations[0].check).toBe('missing-class');
    });

    it('fails when spec requires visible text that is absent', async () => {
        mockIndexOnly('<button>Send</button>');

        const result = await gate.verify('p', '/repo', 'button labeled "Submit"');

        expect(result.passed).toBe(false);
        expect(result.violations[0].check).toBe('missing-text');
    });

    it('fails when spec requires an attribute that is absent', async () => {
        mockIndexOnly('<div></div>');

        const result = await gate.verify('p', '/repo', 'mark it `data-testid="submit"`');

        expect(result.passed).toBe(false);
        expect(result.violations[0].check).toBe('missing-attribute');
    });

    it('passes when every rule kind is satisfied', async () => {
        mockIndexOnly(
            '<button id="inc" class="primary" data-testid="submit">Submit</button>'
        );

        const result = await gate.verify(
            'p',
            '/repo',
            '<button id="inc"> `<button>` `.primary` labeled "Submit" `data-testid="submit"`'
        );

        expect(result.passed).toBe(true);
        expect(result.ruleCount).toBeGreaterThanOrEqual(4);
    });

    it('merges rules from .kageops/test-cases.json', async () => {
        const testCases = JSON.stringify({
            version: 1,
            source: 'scout',
            rules: [{ kind: 'id-exists', id: 'extra-id' }],
        });

        // existsSync: true for index.html AND test-cases.json
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pStr = String(p);
            if (pStr.endsWith('test-cases.json')) return testCases;
            return '<h1 id="from-spec">x</h1>'; // index.html — missing extra-id
        });

        const result = await gate.verify('p', '/repo', 'spec with <h1 id="from-spec">');

        expect(result.passed).toBe(false);
        const missing = result.violations.map((v) => v.expected);
        expect(missing.some((m) => m.includes('extra-id'))).toBe(true);
    });

    it('fails with invalid-test-cases check when test-cases.json is malformed', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            const pStr = String(p);
            if (pStr.endsWith('test-cases.json')) return 'not-json{';
            return '<h1 id="count">x</h1>';
        });

        const result = await gate.verify('p', '/repo', 'with id="count"');

        expect(result.passed).toBe(false);
        expect(result.violations[0].check).toBe('invalid-test-cases');
    });

    it('populates ruleCount and rules on every result', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('<h1 id="count">x</h1>');

        const result = await gate.verify('p', '/repo', 'with id="count"');

        expect(result.ruleCount).toBe(1);
        expect(result.rules).toHaveLength(1);
        expect(result.rules[0].kind).toBe('id-exists');
    });
});
