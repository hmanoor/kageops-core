import { describe, it, expect } from 'vitest';
import {
    buildRedPrompt,
    buildGreenPrompt,
    buildImprovePrompt,
    extractTestFiles,
    extractImplFiles,
} from '../../src/agents/tdd-workflow';

describe('buildRedPrompt', () => {
    it('contains "Write failing tests FIRST" and the task title', () => {
        const result = buildRedPrompt('Add user auth', 'Implement JWT auth');
        expect(result).toContain('Write failing tests FIRST');
        expect(result).toContain('Add user auth');
        expect(result).toContain('Implement JWT auth');
    });

    it('instructs not to write implementation code', () => {
        const result = buildRedPrompt('Task', 'Desc');
        expect(result).toContain('Do NOT write any implementation code');
    });
});

describe('buildGreenPrompt', () => {
    it('contains test code and "minimal implementation"', () => {
        const testCode = 'describe("foo", () => { it("works", () => {}) })';
        const result = buildGreenPrompt('Build API', 'REST endpoints', testCode);
        expect(result).toContain('minimal implementation');
        expect(result).toContain(testCode);
        expect(result).toContain('Build API');
    });

    it('instructs not to modify test files', () => {
        const result = buildGreenPrompt('T', 'D', 'tests');
        expect(result).toContain('Do NOT modify the test files');
    });

    it('always demands actual source code, never a description', () => {
        const result = buildGreenPrompt('T', 'D', 'some tests');
        expect(result).toContain('Output ACTUAL source code, never a description');
    });

    // 2026-06 narration-leak fix: when RED produced no extractable tests,
    // the prompt must NOT claim "tests below ... currently fail" against an
    // empty section (the model spiralled and leaked its reasoning into the
    // file body). It should fall back to spec-driven framing instead.
    describe('empty testCode (RED produced no tests)', () => {
        it('drops the "tests below were written first" framing', () => {
            const result = buildGreenPrompt('Build API', 'REST endpoints', '');
            expect(result).not.toContain('The tests below were written first');
            expect(result).not.toContain('## Existing Tests');
        });

        it('uses spec-driven framing and still names the task + spec', () => {
            const result = buildGreenPrompt('Build API', 'REST endpoints', '   \n  ');
            expect(result).toContain('No test files were available from the RED phase');
            expect(result).toContain('Build API');
            expect(result).toContain('REST endpoints');
        });
    });
});

describe('buildImprovePrompt', () => {
    it('contains both implementation and test code', () => {
        const impl = 'function add(a, b) { return a + b; }';
        const tests = 'it("adds", () => expect(add(1,2)).toBe(3))';
        const result = buildImprovePrompt('Refactor add', impl, tests);
        expect(result).toContain(impl);
        expect(result).toContain(tests);
        expect(result).toContain('Refactor add');
    });

    it('mentions keeping tests green', () => {
        const result = buildImprovePrompt('T', 'impl', 'tests');
        expect(result).toContain('must still pass after refactoring');
    });
});

describe('extractTestFiles', () => {
    const mixedOutput = [
        '--- FILE: src/utils.ts ---',
        'export function add(a: number, b: number) { return a + b; }',
        '--- END FILE ---',
        '',
        '--- FILE: src/utils.test.ts ---',
        'import { add } from "./utils";',
        'it("adds", () => expect(add(1,2)).toBe(3));',
        '--- END FILE ---',
        '',
        '--- FILE: src/helpers.spec.ts ---',
        'it("helps", () => expect(true).toBe(true));',
        '--- END FILE ---',
    ].join('\n');

    it('extracts only .test.ts and .spec.ts files', () => {
        const result = extractTestFiles(mixedOutput);
        expect(result).toContain('utils.test.ts');
        expect(result).toContain('helpers.spec.ts');
        expect(result).not.toContain('src/utils.ts ---\nexport');
    });

    it('returns empty string when no test files present', () => {
        const noTests = '--- FILE: src/index.ts ---\nconsole.log("hi");\n--- END FILE ---';
        expect(extractTestFiles(noTests)).toBe('');
    });

    it('returns empty string for empty input', () => {
        expect(extractTestFiles('')).toBe('');
    });
});

describe('extractImplFiles', () => {
    const mixedOutput = [
        '--- FILE: src/utils.ts ---',
        'export function add(a: number, b: number) { return a + b; }',
        '--- END FILE ---',
        '',
        '--- FILE: src/utils.test.ts ---',
        'it("adds", () => expect(add(1,2)).toBe(3));',
        '--- END FILE ---',
    ].join('\n');

    it('extracts only non-test files', () => {
        const result = extractImplFiles(mixedOutput);
        expect(result).toContain('src/utils.ts');
        expect(result).not.toContain('utils.test.ts');
    });

    it('returns empty string when no impl files present', () => {
        const onlyTests = '--- FILE: src/foo.test.ts ---\ntest code\n--- END FILE ---';
        expect(extractImplFiles(onlyTests)).toBe('');
    });

    it('returns empty string for empty input', () => {
        expect(extractImplFiles('')).toBe('');
    });
});
