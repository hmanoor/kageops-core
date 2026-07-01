import { describe, it, expect } from 'vitest';
import {
    parseReviewMd,
    loadReviewConfig,
    shouldSkipFile,
    buildConfigAwarePrompt,
    filterFilesByConfig,
    DEFAULT_REVIEW_CONFIG,
    type ReviewConfig,
} from '../../src/agents/review-config';

// ── Sample REVIEW.md content ──────────────────────────

const FULL_REVIEW_MD = `# Review Configuration

## Always Check
- No console.log in production code
- All async functions must have error handling

## Style
- Prefer const over let
- Use early returns

## Skip
- *.generated.ts
- dist/
- node_modules/

## Focus
- SQL injection prevention
- Authentication checks

## Settings
- max_findings: 30
- block_on: high
`;

// ── parseReviewMd ─────────────────────────────────────

describe('parseReviewMd', () => {
    it('parses always-check section', () => {
        const config = parseReviewMd(FULL_REVIEW_MD);
        expect(config.alwaysCheck).toEqual([
            'No console.log in production code',
            'All async functions must have error handling',
        ]);
    });

    it('parses style section', () => {
        const config = parseReviewMd(FULL_REVIEW_MD);
        expect(config.style).toEqual(['Prefer const over let', 'Use early returns']);
    });

    it('parses skip section', () => {
        const config = parseReviewMd(FULL_REVIEW_MD);
        expect(config.skip).toEqual(['*.generated.ts', 'dist/', 'node_modules/']);
    });

    it('parses focus section', () => {
        const config = parseReviewMd(FULL_REVIEW_MD);
        expect(config.focus).toEqual([
            'SQL injection prevention',
            'Authentication checks',
        ]);
    });

    it('parses settings: max_findings and block_on', () => {
        const config = parseReviewMd(FULL_REVIEW_MD);
        expect(config.maxFindings).toBe(30);
        expect(config.blockOnSeverity).toBe('high');
    });

    it('returns defaults for empty input', () => {
        const config = parseReviewMd('');
        expect(config).toEqual(DEFAULT_REVIEW_CONFIG);
    });

    it('handles missing sections gracefully', () => {
        const partial = `# Review Configuration\n\n## Always Check\n- Only this rule\n`;
        const config = parseReviewMd(partial);
        expect(config.alwaysCheck).toEqual(['Only this rule']);
        expect(config.style).toEqual([]);
        expect(config.skip).toEqual([]);
        expect(config.focus).toEqual([]);
        expect(config.maxFindings).toBe(DEFAULT_REVIEW_CONFIG.maxFindings);
        expect(config.blockOnSeverity).toBe(DEFAULT_REVIEW_CONFIG.blockOnSeverity);
    });
});

// ── loadReviewConfig ──────────────────────────────────

describe('loadReviewConfig', () => {
    it('returns default config when REVIEW.md not found', () => {
        const readFileFn = (_repoPath: string, _filePath: string): string => {
            throw new Error('File not found');
        };
        const config = loadReviewConfig('/some/repo', readFileFn);
        expect(config).toEqual(DEFAULT_REVIEW_CONFIG);
    });

    it('parses and returns config when REVIEW.md is found', () => {
        const readFileFn = (_repoPath: string, filePath: string): string => {
            if (filePath === 'REVIEW.md') return FULL_REVIEW_MD;
            throw new Error('File not found');
        };
        const config = loadReviewConfig('/some/repo', readFileFn);
        expect(config.maxFindings).toBe(30);
        expect(config.blockOnSeverity).toBe('high');
        expect(config.alwaysCheck).toHaveLength(2);
    });
});

// ── shouldSkipFile ────────────────────────────────────

describe('shouldSkipFile', () => {
    it('matches exact filenames', () => {
        expect(shouldSkipFile('tsconfig.json', ['tsconfig.json'])).toBe(true);
    });

    it('matches exact filenames in subdirectories', () => {
        expect(shouldSkipFile('src/tsconfig.json', ['tsconfig.json'])).toBe(true);
    });

    it('matches glob suffix (*.test.ts)', () => {
        expect(shouldSkipFile('src/auth.test.ts', ['*.test.ts'])).toBe(true);
        expect(shouldSkipFile('src/utils.spec.ts', ['*.test.ts'])).toBe(false);
    });

    it('matches glob suffix (*.generated.ts)', () => {
        expect(shouldSkipFile('src/schema.generated.ts', ['*.generated.ts'])).toBe(true);
        expect(shouldSkipFile('src/schema.ts', ['*.generated.ts'])).toBe(false);
    });

    it('matches directory prefix (dist/)', () => {
        expect(shouldSkipFile('dist/index.js', ['dist/'])).toBe(true);
        expect(shouldSkipFile('dist/sub/file.js', ['dist/'])).toBe(true);
    });

    it('returns false for non-matching files', () => {
        const patterns = ['*.test.ts', 'dist/', 'node_modules/'];
        expect(shouldSkipFile('src/auth.ts', patterns)).toBe(false);
        expect(shouldSkipFile('lib/utils.js', patterns)).toBe(false);
    });
});

// ── buildConfigAwarePrompt ────────────────────────────

describe('buildConfigAwarePrompt', () => {
    const fullConfig: ReviewConfig = {
        alwaysCheck: ['No console.log in production code'],
        style: ['Prefer const over let'],
        focus: ['SQL injection prevention'],
        skip: [],
        maxFindings: 30,
        blockOnSeverity: 'high',
    };

    it('includes always-check rules', () => {
        const prompt = buildConfigAwarePrompt(fullConfig, 'Base prompt');
        expect(prompt).toContain('No console.log in production code');
        expect(prompt).toContain('Always check:');
    });

    it('includes style preferences', () => {
        const prompt = buildConfigAwarePrompt(fullConfig, 'Base prompt');
        expect(prompt).toContain('Prefer const over let');
        expect(prompt).toContain('Style preferences:');
    });

    it('includes focus areas', () => {
        const prompt = buildConfigAwarePrompt(fullConfig, 'Base prompt');
        expect(prompt).toContain('SQL injection prevention');
        expect(prompt).toContain('Focus areas:');
    });

    it('includes maxFindings', () => {
        const prompt = buildConfigAwarePrompt(fullConfig, 'Base prompt');
        expect(prompt).toContain('Max findings: 30');
    });

    it('returns base prompt unchanged when config is all defaults', () => {
        const prompt = buildConfigAwarePrompt(DEFAULT_REVIEW_CONFIG, 'Base prompt');
        expect(prompt).toBe('Base prompt');
    });

    it('includes the base prompt in the output', () => {
        const prompt = buildConfigAwarePrompt(fullConfig, 'Review this code carefully.');
        expect(prompt).toContain('Review this code carefully.');
    });
});

// ── filterFilesByConfig ───────────────────────────────

describe('filterFilesByConfig', () => {
    const config: ReviewConfig = {
        ...DEFAULT_REVIEW_CONFIG,
        skip: ['*.test.ts', 'dist/', 'generated.ts'],
    };

    it('removes files matching skip patterns', () => {
        const files = ['src/auth.test.ts', 'dist/bundle.js', 'src/generated.ts'];
        const result = filterFilesByConfig(files, config);
        expect(result).toEqual([]);
    });

    it('keeps non-matching files', () => {
        const files = ['src/auth.ts', 'src/utils.ts', 'src/index.ts'];
        const result = filterFilesByConfig(files, config);
        expect(result).toEqual(['src/auth.ts', 'src/utils.ts', 'src/index.ts']);
    });

    it('handles mixed matching and non-matching files', () => {
        const files = ['src/auth.ts', 'src/auth.test.ts', 'dist/bundle.js'];
        const result = filterFilesByConfig(files, config);
        expect(result).toEqual(['src/auth.ts']);
    });

    it('returns all files when skip list is empty', () => {
        const files = ['src/auth.ts', 'src/utils.ts'];
        const result = filterFilesByConfig(files, DEFAULT_REVIEW_CONFIG);
        expect(result).toEqual(files);
    });
});

// ── DEFAULT_REVIEW_CONFIG ─────────────────────────────

describe('DEFAULT_REVIEW_CONFIG', () => {
    it('has expected default values', () => {
        expect(DEFAULT_REVIEW_CONFIG.alwaysCheck).toEqual([]);
        expect(DEFAULT_REVIEW_CONFIG.style).toEqual([]);
        expect(DEFAULT_REVIEW_CONFIG.skip).toEqual([]);
        expect(DEFAULT_REVIEW_CONFIG.focus).toEqual([]);
        expect(DEFAULT_REVIEW_CONFIG.maxFindings).toBe(50);
        expect(DEFAULT_REVIEW_CONFIG.blockOnSeverity).toBe('critical');
    });
});
