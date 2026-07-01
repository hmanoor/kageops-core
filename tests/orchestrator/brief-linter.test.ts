import { describe, it, expect } from 'vitest';
import { lintBrief } from '../../src/orchestrator/brief-linter';

describe('lintBrief (F-361)', () => {
    it('flags a very short brief', () => {
        const result = lintBrief('Counter');
        const kinds = result.warnings.map((w) => w.kind);
        expect(kinds).toContain('very-short');
        expect(result.scoreable).toBe(false);
    });

    it('flags a brief with no required IDs', () => {
        const brief = 'A delightful attendance tracker for a single classroom. Must display today, week, and month rollups.';
        const result = lintBrief(brief);
        expect(result.warnings.map((w) => w.kind)).toContain('no-required-ids');
        // Has "must display" → measurable criteria PASSES
        expect(result.warnings.map((w) => w.kind)).not.toContain('no-measurable-criteria');
    });

    it('flags a brief with no measurable criteria', () => {
        const brief = 'A counter app. Click button #plus to increment #count value. Vanilla HTML + JS, no build.';
        const result = lintBrief(brief);
        expect(result.warnings.map((w) => w.kind)).toContain('no-measurable-criteria');
        // Has `#plus` and `#count` → required-IDs PASSES
        expect(result.warnings.map((w) => w.kind)).not.toContain('no-required-ids');
    });

    it('flags a brief with no tech-stack hint', () => {
        const brief = 'Build a thing. It must contain #header and #footer elements. The header should display the title.';
        const result = lintBrief(brief);
        expect(result.warnings.map((w) => w.kind)).toContain('no-tech-stack-hint');
    });

    it('marks scoreable=true when both required-IDs AND measurable criteria are present', () => {
        const brief = 'A counter app. Must contain a #plus button and a #count display. Vanilla HTML + CSS + JS, no build.';
        const result = lintBrief(brief);
        expect(result.scoreable).toBe(true);
    });

    it('accepts both id="X" and #X syntaxes for required-IDs', () => {
        const brief1 = 'Must contain id="foo" and id="bar". Built in HTML.';
        const brief2 = 'Must contain #foo and #bar. Built in HTML.';
        expect(lintBrief(brief1).warnings.map((w) => w.kind)).not.toContain('no-required-ids');
        expect(lintBrief(brief2).warnings.map((w) => w.kind)).not.toContain('no-required-ids');
    });
});
