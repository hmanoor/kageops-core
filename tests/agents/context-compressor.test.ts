import { describe, it, expect } from 'vitest';
import { compressContext, compressIfLarge, estimateTokens } from '../../src/agents/context-compressor';

describe('context-compressor', () => {
    describe('compressContext', () => {
        it('preserves fenced code blocks verbatim', () => {
            const input = 'The function is:\n```typescript\nconst a = the + an;\n```\nEnd.';
            const result = compressContext(input);
            expect(result).toContain('```typescript\nconst a = the + an;\n```');
        });

        it('preserves inline code verbatim', () => {
            const input = 'Use `the variable` in the code.';
            const result = compressContext(input);
            expect(result).toContain('`the variable`');
        });

        it('preserves URLs verbatim', () => {
            const input = 'Visit https://example.com/the/path for details.';
            const result = compressContext(input);
            expect(result).toContain('https://example.com/the/path');
        });

        it('preserves headings verbatim', () => {
            const input = '# The Main Heading\nSome prose about the topic.';
            const result = compressContext(input);
            expect(result).toContain('# The Main Heading');
        });

        it('preserves version numbers verbatim', () => {
            const input = 'We upgraded from v1.2.3 to the latest 2.0.0 release.';
            const result = compressContext(input);
            expect(result).toContain('v1.2.3');
            expect(result).toContain('2.0.0');
        });

        it('drops articles from prose', () => {
            const result = compressContext('This is a test of the system and an example.');
            expect(result).not.toMatch(/\ba\b/i);
            expect(result).not.toMatch(/\bthe\b/i);
            expect(result).not.toMatch(/\ban\b/i);
        });

        it('removes filler phrases', () => {
            const input = 'It is important to note that the system works. Please note that it is fast.';
            const result = compressContext(input);
            expect(result).not.toContain('It is important to note that');
            expect(result).not.toContain('Please note that');
        });

        it('removes hedging words', () => {
            const input = 'I think this works. I believe it is correct. Perhaps we should check.';
            const result = compressContext(input);
            expect(result).not.toContain('I think');
            expect(result).not.toContain('I believe');
            expect(result).not.toContain('Perhaps');
        });

        it('collapses multiple spaces to single space', () => {
            const result = compressContext('word    another   word');
            expect(result).not.toContain('  ');
        });

        it('collapses multiple newlines to max 2', () => {
            const result = compressContext('line1\n\n\n\n\nline2');
            expect(result).toBe('line1\n\nline2');
        });

        it('compresses common phrases', () => {
            const input = 'We need to do this in order to fix the bug. Due to the fact that it fails, we must act.';
            const result = compressContext(input);
            expect(result).toContain('to fix');
            expect(result).toContain('because');
            expect(result).not.toContain('in order to');
            expect(result).not.toContain('due to the fact that');
        });

        it('only compresses prose, not code in mixed content', () => {
            const input = [
                'The system basically needs a fix.',
                '```js',
                'const the = "article";',
                '```',
                'Essentially the output is wrong.',
            ].join('\n');
            const result = compressContext(input);
            // Code preserved
            expect(result).toContain('const the = "article";');
            // Prose compressed
            expect(result).not.toMatch(/\bessentially\b/i);
            expect(result).not.toMatch(/\bbasically\b/i);
        });

        it('returns empty string for empty input', () => {
            expect(compressContext('')).toBe('');
        });
    });

    describe('estimateTokens', () => {
        it('returns reasonable estimate based on char count', () => {
            const text = 'a'.repeat(400);
            expect(estimateTokens(text)).toBe(100);
        });

        it('returns 0 for empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });
    });

    describe('compressIfLarge', () => {
        it('returns original text when below threshold', () => {
            const short = 'Hello world.';
            expect(compressIfLarge(short, 500)).toBe(short);
        });

        it('compresses text when above threshold', () => {
            // 2001 chars / 4 = 500 tokens, threshold is 500, so at 2004+ chars it compresses
            const long = 'The basically important thing is that '.repeat(60);
            const result = compressIfLarge(long, 100);
            expect(result.length).toBeLessThan(long.length);
        });

        it('uses default threshold of 500 tokens', () => {
            const short = 'The short text.';
            expect(compressIfLarge(short)).toBe(short);
        });
    });
});
