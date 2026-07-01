/**
 * SpecRuleEngine unit tests
 *
 * Covers:
 *   - parseSpec — all 5 rule kinds + edge cases
 *   - stripHtml — tag/comment/entity stripping
 *   - checkRule — pass/fail for each rule kind
 *   - loadTestCasesJson — Zod schema validation
 */

import { describe, it, expect } from 'vitest';
import {
    parseSpec,
    checkRule,
    checkAllRules,
    stripHtml,
    loadTestCasesJson,
    ruleSeverity,
    TestCaseFileSchema,
    type SpecRule,
} from '../../src/orchestrator/spec-rule-engine';

// ── parseSpec ─────────────────────────────────────────────────────────

describe('parseSpec', () => {
    describe('id-exists rules', () => {
        it('extracts double-quoted IDs', () => {
            const rules = parseSpec('<h1 id="count">');
            expect(rules).toContainEqual({ kind: 'id-exists', id: 'count' });
        });

        it('extracts single-quoted IDs', () => {
            const rules = parseSpec("<button id='inc'>");
            expect(rules).toContainEqual({ kind: 'id-exists', id: 'inc' });
        });

        it('extracts unquoted IDs only inside tag context', () => {
            const rules = parseSpec('<button id=increment>');
            expect(rules).toContainEqual({ kind: 'id-exists', id: 'increment' });
        });

        it('does NOT extract id= from plain prose', () => {
            const rules = parseSpec('the kid=happy not a tag');
            expect(rules.filter((r) => r.kind === 'id-exists')).toHaveLength(0);
        });

        it('deduplicates repeated IDs', () => {
            const rules = parseSpec('id="x" and <h1 id="x">');
            expect(rules.filter((r) => r.kind === 'id-exists')).toHaveLength(1);
        });
    });

    describe('tag-exists rules', () => {
        it('extracts backtick-wrapped HTML tag', () => {
            const rules = parseSpec('needs a `<button>` for submit');
            expect(rules).toContainEqual({ kind: 'tag-exists', tag: 'button' });
        });

        it('handles self-closing tags', () => {
            const rules = parseSpec('use `<input />` control');
            expect(rules).toContainEqual({ kind: 'tag-exists', tag: 'input' });
        });

        it('lowercases tag names', () => {
            const rules = parseSpec('render a `<BUTTON>` element');
            expect(rules).toContainEqual({ kind: 'tag-exists', tag: 'button' });
        });

        it('deduplicates repeated tags', () => {
            const rules = parseSpec('a `<button>` and another `<button>`');
            expect(rules.filter((r) => r.kind === 'tag-exists')).toHaveLength(1);
        });
    });

    describe('class-exists rules', () => {
        it('extracts backtick-wrapped CSS class', () => {
            const rules = parseSpec('style it with `.primary-button`');
            expect(rules).toContainEqual({ kind: 'class-exists', className: 'primary-button' });
        });

        it('deduplicates repeated classes', () => {
            const rules = parseSpec('use `.btn` and also `.btn`');
            expect(rules.filter((r) => r.kind === 'class-exists')).toHaveLength(1);
        });
    });

    describe('text-contains rules', () => {
        it('extracts label directive with double quotes', () => {
            const rules = parseSpec('button label "Submit"');
            expect(rules).toContainEqual({ kind: 'text-contains', text: 'Submit' });
        });

        it('extracts labeled directive', () => {
            const rules = parseSpec('a button labeled "Go"');
            expect(rules).toContainEqual({ kind: 'text-contains', text: 'Go' });
        });

        it('extracts says directive', () => {
            const rules = parseSpec('heading says "Hello World"');
            expect(rules).toContainEqual({ kind: 'text-contains', text: 'Hello World' });
        });

        it('extracts text: colon form', () => {
            const rules = parseSpec('text: "Welcome"');
            expect(rules).toContainEqual({ kind: 'text-contains', text: 'Welcome' });
        });

        it('supports single quotes', () => {
            const rules = parseSpec("button labeled 'Cancel'");
            expect(rules).toContainEqual({ kind: 'text-contains', text: 'Cancel' });
        });

        it('deduplicates repeated text directives', () => {
            const rules = parseSpec('label "Hi" and labeled "Hi"');
            expect(rules.filter((r) => r.kind === 'text-contains')).toHaveLength(1);
        });
    });

    describe('attribute-exists rules', () => {
        it('extracts backtick-wrapped attribute with value', () => {
            const rules = parseSpec('mark it `data-testid="submit"`');
            expect(rules).toContainEqual({
                kind: 'attribute-exists',
                name: 'data-testid',
                value: 'submit',
            });
        });

        it('extracts unquoted attribute value', () => {
            const rules = parseSpec('set `role=button` on it');
            expect(rules).toContainEqual({
                kind: 'attribute-exists',
                name: 'role',
                value: 'button',
            });
        });

        it('skips id= attributes (covered by id-exists)', () => {
            const rules = parseSpec('use `id="count"`');
            expect(rules.filter((r) => r.kind === 'attribute-exists')).toHaveLength(0);
        });

        it('skips class= attributes (covered by class-exists)', () => {
            const rules = parseSpec('use `class="btn"`');
            expect(rules.filter((r) => r.kind === 'attribute-exists')).toHaveLength(0);
        });

        it('deduplicates', () => {
            const rules = parseSpec('use `aria-label="hi"` and `aria-label="hi"`');
            expect(rules.filter((r) => r.kind === 'attribute-exists')).toHaveLength(1);
        });
    });

    it('returns empty for spec with no assertions', () => {
        expect(parseSpec('build me something nice')).toEqual([]);
    });

    it('combines multiple rule kinds from a realistic spec', () => {
        const desc =
            'Counter app with <h1 id="count"> and `<button>` labeled "Increment" marked `data-testid="inc"`';
        const rules = parseSpec(desc);
        const kinds = new Set(rules.map((r) => r.kind));
        expect(kinds.has('id-exists')).toBe(true);
        expect(kinds.has('tag-exists')).toBe(true);
        expect(kinds.has('text-contains')).toBe(true);
        expect(kinds.has('attribute-exists')).toBe(true);
    });
});

// ── stripHtml ─────────────────────────────────────────────────────────

describe('stripHtml', () => {
    it('removes tags and returns visible text', () => {
        expect(stripHtml('<h1>Hello</h1> <p>world</p>')).toBe('Hello world');
    });

    it('removes script blocks entirely', () => {
        const html = '<p>keep</p><script>alert("x")</script><p>also keep</p>';
        expect(stripHtml(html)).toBe('keep also keep');
    });

    it('removes style blocks entirely', () => {
        expect(stripHtml('<p>ok</p><style>body{color:red}</style>')).toBe('ok');
    });

    it('removes HTML comments', () => {
        expect(stripHtml('<p>ok</p><!-- hidden --><p>visible</p>')).toBe('ok visible');
    });

    it('decodes common entities', () => {
        expect(stripHtml('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
    });

    it('collapses whitespace', () => {
        expect(stripHtml('<p>hi\n\n   there</p>')).toBe('hi there');
    });
});

// ── checkRule ─────────────────────────────────────────────────────────

describe('checkRule', () => {
    describe('id-exists', () => {
        const rule: SpecRule = { kind: 'id-exists', id: 'count' };

        it('passes when id is present in HTML', () => {
            expect(checkRule(rule, '<h1 id="count">0</h1>').passed).toBe(true);
        });

        it('passes with single-quoted id', () => {
            expect(checkRule(rule, "<h1 id='count'>").passed).toBe(true);
        });

        it('fails when id is absent', () => {
            const check = checkRule(rule, '<h1 id="other">0</h1>');
            expect(check.passed).toBe(false);
            expect(check.message).toContain('count');
        });
    });

    describe('tag-exists', () => {
        const rule: SpecRule = { kind: 'tag-exists', tag: 'button' };

        it('passes when tag is present', () => {
            expect(checkRule(rule, '<button>+</button>').passed).toBe(true);
        });

        it('passes with attributes on tag', () => {
            expect(checkRule(rule, '<button class="x">+</button>').passed).toBe(true);
        });

        it('fails when tag is absent', () => {
            expect(checkRule(rule, '<div>+</div>').passed).toBe(false);
        });

        it('does not match substring tags (buttonx should not match button)', () => {
            expect(checkRule(rule, '<buttonx>+</buttonx>').passed).toBe(false);
        });
    });

    describe('class-exists', () => {
        const rule: SpecRule = { kind: 'class-exists', className: 'btn' };

        it('passes when class token is present alone', () => {
            expect(checkRule(rule, '<a class="btn">x</a>').passed).toBe(true);
        });

        it('passes when class token is one of several', () => {
            expect(checkRule(rule, '<a class="primary btn large">x</a>').passed).toBe(true);
        });

        it('fails on substring match (btn-primary ≠ btn)', () => {
            expect(checkRule(rule, '<a class="btn-primary">x</a>').passed).toBe(false);
        });

        it('fails when class is absent', () => {
            expect(checkRule(rule, '<a class="other">x</a>').passed).toBe(false);
        });
    });

    describe('text-contains', () => {
        const rule: SpecRule = { kind: 'text-contains', text: 'Submit' };

        it('passes when visible text contains the phrase', () => {
            expect(checkRule(rule, '<button>Submit</button>').passed).toBe(true);
        });

        it('is case-insensitive', () => {
            expect(checkRule(rule, '<button>submit</button>').passed).toBe(true);
        });

        it('ignores text inside script tags', () => {
            expect(checkRule(rule, '<script>"Submit"</script>').passed).toBe(false);
        });

        it('fails when phrase is absent', () => {
            expect(checkRule(rule, '<button>Send</button>').passed).toBe(false);
        });
    });

    describe('attribute-exists', () => {
        it('passes when attribute with matching value exists', () => {
            const rule: SpecRule = { kind: 'attribute-exists', name: 'data-testid', value: 'x' };
            expect(checkRule(rule, '<div data-testid="x"></div>').passed).toBe(true);
        });

        it('fails when value differs', () => {
            const rule: SpecRule = { kind: 'attribute-exists', name: 'data-testid', value: 'x' };
            expect(checkRule(rule, '<div data-testid="y"></div>').passed).toBe(false);
        });

        it('passes when value is null and attribute present with any value', () => {
            const rule: SpecRule = { kind: 'attribute-exists', name: 'role', value: null };
            expect(checkRule(rule, '<div role="button"></div>').passed).toBe(true);
        });

        it('fails when attribute entirely absent', () => {
            const rule: SpecRule = { kind: 'attribute-exists', name: 'role', value: null };
            expect(checkRule(rule, '<div></div>').passed).toBe(false);
        });
    });
});

// ── checkAllRules ─────────────────────────────────────────────────────

describe('checkAllRules', () => {
    it('preserves rule order and returns one check per rule', () => {
        const rules: readonly SpecRule[] = [
            { kind: 'id-exists', id: 'a' },
            { kind: 'tag-exists', tag: 'button' },
        ];
        const checks = checkAllRules(rules, '<button id="a">x</button>');
        expect(checks).toHaveLength(2);
        expect(checks[0].rule).toBe(rules[0]);
        expect(checks[1].rule).toBe(rules[1]);
        expect(checks.every((c) => c.passed)).toBe(true);
    });

    it('reports mixed pass/fail accurately', () => {
        const rules: readonly SpecRule[] = [
            { kind: 'id-exists', id: 'present' },
            { kind: 'id-exists', id: 'missing' },
        ];
        const checks = checkAllRules(rules, '<h1 id="present">x</h1>');
        expect(checks[0].passed).toBe(true);
        expect(checks[1].passed).toBe(false);
    });
});

// ── Rule severity (two-tier MUST/SHOULD) ─────────────────────────────

describe('ruleSeverity / parseSpec SHOULD prefix', () => {
    it('defaults to "must" when no severity is set', () => {
        const rule: SpecRule = { kind: 'id-exists', id: 'foo' };
        expect(ruleSeverity(rule)).toBe('must');
    });

    it('respects explicit severity on a rule', () => {
        const must: SpecRule = { kind: 'id-exists', id: 'foo', severity: 'must' };
        const should: SpecRule = { kind: 'id-exists', id: 'foo', severity: 'should' };
        expect(ruleSeverity(must)).toBe('must');
        expect(ruleSeverity(should)).toBe('should');
    });

    it('parseSpec extracts text-contains as MUST when no SHOULD prefix is present', () => {
        const rules = parseSpec('the page must include text "Welcome"');
        const text = rules.find((r) => r.kind === 'text-contains');
        expect(text).toBeDefined();
        expect(ruleSeverity(text!)).toBe('must');
    });

    it('parseSpec extracts text-contains as SHOULD when line is prefixed with SHOULD', () => {
        const rules = parseSpec('SHOULD include text "BUDGET KILL — tasks cancelled."');
        const text = rules.find((r) => r.kind === 'text-contains');
        expect(text).toBeDefined();
        expect(text?.text).toBe('BUDGET KILL — tasks cancelled.');
        expect(ruleSeverity(text!)).toBe('should');
    });

    it('SHOULD prefix only applies to the same line, not the next', () => {
        const desc = `SHOULD include text "First"\nMust include text "Second"`;
        const rules = parseSpec(desc);
        const first = rules.find((r) => r.kind === 'text-contains' && r.text === 'First');
        const second = rules.find((r) => r.kind === 'text-contains' && r.text === 'Second');
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(ruleSeverity(first!)).toBe('should');
        expect(ruleSeverity(second!)).toBe('must');
    });

    it('SHOULD as a substring of another word (e.g. "shouldnt") does not trigger', () => {
        const rules = parseSpec('the user shouldnt-care text "ignored"');
        const text = rules.find((r) => r.kind === 'text-contains' && r.text === 'ignored');
        expect(text).toBeDefined();
        expect(ruleSeverity(text!)).toBe('must');
    });
});

// ── test-cases.json severity field ─────────────────────────────────────

describe('test-cases.json severity field', () => {
    it('accepts severity on rules', () => {
        const raw = JSON.stringify({
            version: 1,
            rules: [
                { kind: 'id-exists', id: 'main', severity: 'must' },
                { kind: 'text-contains', text: 'optional', severity: 'should' },
            ],
        });
        const rules = loadTestCasesJson(raw);
        expect(rules).toHaveLength(2);
        expect(ruleSeverity(rules[0])).toBe('must');
        expect(ruleSeverity(rules[1])).toBe('should');
    });

    it('treats missing severity as MUST (backwards compat)', () => {
        const raw = JSON.stringify({
            version: 1,
            rules: [{ kind: 'id-exists', id: 'main' }],
        });
        const rules = loadTestCasesJson(raw);
        expect(ruleSeverity(rules[0])).toBe('must');
    });

    it('rejects unknown severity values', () => {
        const raw = JSON.stringify({
            version: 1,
            rules: [{ kind: 'id-exists', id: 'main', severity: 'maybe' }],
        });
        expect(() => loadTestCasesJson(raw)).toThrow();
    });
});

// ── loadTestCasesJson ────────────────────────────────────────────────

describe('loadTestCasesJson', () => {
    it('parses a valid Scout test-cases.json', () => {
        const raw = JSON.stringify({
            version: 1,
            source: 'scout',
            rules: [
                { kind: 'id-exists', id: 'count' },
                { kind: 'tag-exists', tag: 'button' },
            ],
        });
        const rules = loadTestCasesJson(raw);
        expect(rules).toHaveLength(2);
    });

    it('defaults source to manual when omitted', () => {
        const raw = JSON.stringify({ version: 1, rules: [] });
        const parsed = TestCaseFileSchema.parse(JSON.parse(raw));
        expect(parsed.source).toBe('manual');
    });

    it('throws on wrong version', () => {
        const raw = JSON.stringify({ version: 2, rules: [] });
        expect(() => loadTestCasesJson(raw)).toThrow();
    });

    it('throws on unknown rule kind', () => {
        const raw = JSON.stringify({
            version: 1,
            rules: [{ kind: 'bogus-kind', foo: 'bar' }],
        });
        expect(() => loadTestCasesJson(raw)).toThrow();
    });

    it('throws on more than 100 rules', () => {
        const rules = Array.from({ length: 101 }, (_, i) => ({
            kind: 'id-exists' as const,
            id: `x${i}`,
        }));
        const raw = JSON.stringify({ version: 1, rules });
        expect(() => loadTestCasesJson(raw)).toThrow();
    });

    it('throws on malformed JSON', () => {
        expect(() => loadTestCasesJson('not json {')).toThrow();
    });
});
