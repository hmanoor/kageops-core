/**
 * P1-07 — forge-revision-prompt module (token-budget-aware prompt
 * builder). The pure function the production Forge handler + the
 * benchmark script both consume, so what we test here is exactly
 * what ships.
 *
 * Coverage:
 *   - Prompt scaffold contains all 6 hard rules (the P1-06b five +
 *     P1-07's new MODIFIED-FILES sentinel rule).
 *   - Instruction is surfaced verbatim + quoted.
 *   - File list rendered as a bullet list; "(none — ...)" placeholder
 *     when empty.
 *   - File contents injected into the {{FILES_CONTEXT}} placeholder.
 *   - estimatedTokens scales roughly with prompt length.
 *   - Budget guard: when budgetTokens is generous, no truncation.
 *   - Budget guard: when budget is tight, per-file content is sliced
 *     (small files preserved, large files trimmed with a marker).
 *   - Budget guard: truncatedFiles[] records which files got clipped.
 *   - hitBudget flag reflects truncation OR total-over-budget.
 *   - estimateFromScratchPromptTokens scales with spec length.
 */

import { describe, it, expect } from 'vitest';
import {
    buildRevisionPrompt,
    estimateFromScratchPromptTokens,
    REVISION_PROMPT_TOKEN_BUDGET,
    CHARS_PER_TOKEN,
    type RevisionFile,
} from '../../src/agents/forge-revision-prompt';

function makeFile(name: string, length: number): RevisionFile {
    return { path: name, content: 'x'.repeat(length) };
}

describe('buildRevisionPrompt() — scaffold + rules', () => {
    it('quotes the operator instruction verbatim', () => {
        const { prompt } = buildRevisionPrompt('fix the dark-mode toggle', []);
        expect(prompt).toContain('> fix the dark-mode toggle');
        expect(prompt).toMatch(/Operator instruction/i);
    });

    it('lists file paths as a bullet list when populated', () => {
        const { prompt } = buildRevisionPrompt('change colour', [
            { path: 'index.html', content: '<html/>' },
            { path: 'src/main.tsx', content: 'export {};' },
        ]);
        expect(prompt).toContain('- index.html');
        expect(prompt).toContain('- src/main.tsx');
    });

    it('falls back to "(none — write new files as needed)" when no targets', () => {
        const { prompt } = buildRevisionPrompt('add a contact form', []);
        expect(prompt).toContain('(none — write new files as needed)');
        expect(prompt).toContain('(no existing files found — fresh write OK)');
    });

    it('includes all six rules (modify-only, full-file, omit-unchanged, no-regenerate, output-only, MODIFIED-FILES sentinel)', () => {
        const { prompt } = buildRevisionPrompt('any', []);
        expect(prompt).toMatch(/Modify ONLY/);
        expect(prompt).toMatch(/FULL UPDATED FILE/);
        expect(prompt).toMatch(/OMIT the block entirely/);
        expect(prompt).toMatch(/Do not regenerate from scratch/);
        expect(prompt).toMatch(/Output ONLY the file blocks/);
        // P1-07 addition:
        expect(prompt).toMatch(/MODIFIED-FILES:/);
        expect(prompt).toMatch(/MODIFIED-FILES: none/);
    });

    it('renders file contents inside FILE blocks', () => {
        const { prompt } = buildRevisionPrompt('change', [
            { path: 'a.html', content: '<title>hello</title>' },
        ]);
        expect(prompt).toContain('--- FILE: a.html ---');
        expect(prompt).toContain('<title>hello</title>');
        expect(prompt).toContain('--- END FILE ---');
    });
});

describe('buildRevisionPrompt() — token budget', () => {
    it('returns no truncation when total fits comfortably', () => {
        const files = [
            makeFile('a.html', 500),
            makeFile('b.css', 800),
        ];
        const r = buildRevisionPrompt('small change', files);
        expect(r.truncatedFiles).toEqual([]);
        expect(r.hitBudget).toBe(false);
        // Estimated tokens should be a few hundred (scaffold + files).
        expect(r.estimatedTokens).toBeGreaterThan(0);
        expect(r.estimatedTokens).toBeLessThan(REVISION_PROMPT_TOKEN_BUDGET);
    });

    it('truncates large files when over budget; flags them in truncatedFiles', () => {
        // 60k of total file content vs default 8k token budget (~32k chars).
        const files = [
            makeFile('huge.html', 30_000),
            makeFile('also-huge.css', 30_000),
        ];
        const r = buildRevisionPrompt('something', files);
        expect(r.hitBudget).toBe(true);
        // Both files should be in truncatedFiles since neither fit.
        expect(r.truncatedFiles).toContain('huge.html');
        expect(r.truncatedFiles).toContain('also-huge.css');
        // Truncation markers appear in the prompt body.
        expect(r.prompt).toMatch(/\[\.\.\.truncated — file was 30000 bytes/);
    });

    it('preserves a small file even when sharing budget with a large one (fair-share allocation)', () => {
        const files = [
            makeFile('tiny.html', 500),       // 500 chars — easily fits
            makeFile('huge.css', 50_000),     // 50k — must clip
        ];
        const r = buildRevisionPrompt('change', files);
        expect(r.truncatedFiles).toEqual(['huge.css']);
        // The tiny file appears in full.
        expect(r.prompt).toContain('--- FILE: tiny.html ---\n' + 'x'.repeat(500));
    });

    it('honours an explicit small budget by clipping even modest files', () => {
        const files = [makeFile('a.html', 5_000)];
        const r = buildRevisionPrompt('tight', files, { budgetTokens: 500 });
        expect(r.hitBudget).toBe(true);
        expect(r.truncatedFiles).toEqual(['a.html']);
    });

    it('disables truncation when budget = Infinity', () => {
        const files = [makeFile('huge.html', 50_000)];
        const r = buildRevisionPrompt('any', files, { budgetTokens: Infinity });
        expect(r.truncatedFiles).toEqual([]);
        // The full 50k content is in the prompt.
        expect(r.prompt).toContain('x'.repeat(50_000));
    });

    it('hitBudget=true when prompt exceeds budget even without truncation (e.g. instruction is huge)', () => {
        const r = buildRevisionPrompt('z'.repeat(60_000), [], { budgetTokens: 500 });
        expect(r.hitBudget).toBe(true);
        // No files → nothing to truncate.
        expect(r.truncatedFiles).toEqual([]);
    });

    it('estimatedTokens roughly tracks prompt length / CHARS_PER_TOKEN', () => {
        const r = buildRevisionPrompt('small', [makeFile('a.html', 1000)]);
        // ±10% tolerance for the per-file truncation marker overhead.
        const expected = Math.ceil(r.prompt.length / CHARS_PER_TOKEN);
        expect(r.estimatedTokens).toBe(expected);
    });
});

describe('estimateFromScratchPromptTokens()', () => {
    it('returns a sensible baseline for the from-scratch comparison', () => {
        const spec = 'Build a hello-world landing page with a Click me button.';
        const tokens = estimateFromScratchPromptTokens(spec);
        // Scaffold(1500) + spec(56*1.4 = 79) chars / 4 = ~395 tokens.
        expect(tokens).toBeGreaterThan(350);
        expect(tokens).toBeLessThan(450);
    });

    it('scales with spec length', () => {
        const small = estimateFromScratchPromptTokens('a');
        const big = estimateFromScratchPromptTokens('a'.repeat(10_000));
        expect(big).toBeGreaterThan(small * 5);
    });
});
