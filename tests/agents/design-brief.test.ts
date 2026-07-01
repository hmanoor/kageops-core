import { describe, it, expect } from 'vitest';
import {
    ANTI_GENERIC_RULES,
    DEFAULT_BRIEF,
    buildDesignBriefPrompt,
    buildEnhancedDesignPrompt,
    parseDesignBrief,
} from '../../src/agents/design-brief';

describe('ANTI_GENERIC_RULES', () => {
    it('has at least 6 rules', () => {
        expect(ANTI_GENERIC_RULES.length).toBeGreaterThanOrEqual(6);
    });

    it('each rule is a non-empty string', () => {
        for (const rule of ANTI_GENERIC_RULES) {
            expect(typeof rule).toBe('string');
            expect(rule.length).toBeGreaterThan(0);
        }
    });
});

describe('DEFAULT_BRIEF', () => {
    it('has all required fields populated', () => {
        expect(DEFAULT_BRIEF.purpose).toBeTruthy();
        expect(DEFAULT_BRIEF.audience).toBeTruthy();
        expect(DEFAULT_BRIEF.aesthetic).toBeTruthy();
        expect(Array.isArray(DEFAULT_BRIEF.constraints)).toBe(true);
        expect(Array.isArray(DEFAULT_BRIEF.antiPatterns)).toBe(true);
        expect(Array.isArray(DEFAULT_BRIEF.inspirations)).toBe(true);
    });
});

describe('buildDesignBriefPrompt', () => {
    const prompt = buildDesignBriefPrompt('Task Title', 'A detailed description');

    it('includes the task title', () => {
        expect(prompt).toContain('Task Title');
    });

    it('includes the task description', () => {
        expect(prompt).toContain('A detailed description');
    });

    it('includes anti-generic rules', () => {
        for (const rule of ANTI_GENERIC_RULES) {
            expect(prompt).toContain(rule);
        }
    });

    it('includes structured output markers', () => {
        expect(prompt).toContain('--- DESIGN BRIEF ---');
        expect(prompt).toContain('--- END BRIEF ---');
    });

    it('includes all six field labels', () => {
        expect(prompt).toContain('PURPOSE:');
        expect(prompt).toContain('AUDIENCE:');
        expect(prompt).toContain('AESTHETIC:');
        expect(prompt).toContain('CONSTRAINTS:');
        expect(prompt).toContain('ANTI_PATTERNS:');
        expect(prompt).toContain('INSPIRATIONS:');
    });
});

describe('parseDesignBrief', () => {
    const STRUCTURED_OUTPUT = `
Some preamble text that should be ignored.

--- DESIGN BRIEF ---
PURPOSE: Help developers track their tasks efficiently
AUDIENCE: Software engineers, intermediate skill level, desktop context
AESTHETIC: Minimal and focused, dark mode first
CONSTRAINTS: Keyboard accessible | WCAG AA contrast | No external dependencies
ANTI_PATTERNS: Avoid drag-and-drop complexity | No social sharing buttons
INSPIRATIONS: Linear app | Obsidian | GitHub Issues
--- END BRIEF ---

Some trailing text.
`.trim();

    it('parses PURPOSE correctly', () => {
        const brief = parseDesignBrief(STRUCTURED_OUTPUT);
        expect(brief.purpose).toBe('Help developers track their tasks efficiently');
    });

    it('parses AUDIENCE correctly', () => {
        const brief = parseDesignBrief(STRUCTURED_OUTPUT);
        expect(brief.audience).toBe('Software engineers, intermediate skill level, desktop context');
    });

    it('parses AESTHETIC correctly', () => {
        const brief = parseDesignBrief(STRUCTURED_OUTPUT);
        expect(brief.aesthetic).toBe('Minimal and focused, dark mode first');
    });

    it('handles pipe-separated CONSTRAINTS list', () => {
        const brief = parseDesignBrief(STRUCTURED_OUTPUT);
        expect(brief.constraints).toHaveLength(3);
        expect(brief.constraints).toContain('Keyboard accessible');
        expect(brief.constraints).toContain('WCAG AA contrast');
        expect(brief.constraints).toContain('No external dependencies');
    });

    it('handles pipe-separated ANTI_PATTERNS list', () => {
        const brief = parseDesignBrief(STRUCTURED_OUTPUT);
        expect(brief.antiPatterns).toHaveLength(2);
        expect(brief.antiPatterns).toContain('Avoid drag-and-drop complexity');
        expect(brief.antiPatterns).toContain('No social sharing buttons');
    });

    it('handles pipe-separated INSPIRATIONS list', () => {
        const brief = parseDesignBrief(STRUCTURED_OUTPUT);
        expect(brief.inspirations).toHaveLength(3);
        expect(brief.inspirations).toContain('Linear app');
        expect(brief.inspirations).toContain('Obsidian');
        expect(brief.inspirations).toContain('GitHub Issues');
    });

    it('returns DEFAULT_BRIEF fields for completely malformed input', () => {
        const brief = parseDesignBrief('This is not a design brief at all.');
        expect(brief.purpose).toBe(DEFAULT_BRIEF.purpose);
        expect(brief.audience).toBe(DEFAULT_BRIEF.audience);
        expect(brief.aesthetic).toBe(DEFAULT_BRIEF.aesthetic);
    });

    it('returns empty arrays for missing list fields on malformed input', () => {
        const brief = parseDesignBrief('This is not a design brief at all.');
        expect(brief.constraints).toHaveLength(0);
        expect(brief.antiPatterns).toHaveLength(0);
        expect(brief.inspirations).toHaveLength(0);
    });

    it('still parses fields present when block markers are missing', () => {
        const unstructured =
            'PURPOSE: Help users find recipes\nAUDIENCE: Home cooks\nAESTHETIC: Warm and inviting';
        const brief = parseDesignBrief(unstructured);
        expect(brief.purpose).toBe('Help users find recipes');
        expect(brief.audience).toBe('Home cooks');
        expect(brief.aesthetic).toBe('Warm and inviting');
    });
});

describe('buildEnhancedDesignPrompt', () => {
    const brief = {
        purpose: 'Track developer tasks',
        audience: 'Software engineers',
        aesthetic: 'Minimal dark',
        constraints: ['Keyboard accessible', 'WCAG AA'] as const,
        antiPatterns: ['No drag-and-drop'] as const,
        inspirations: ['Linear'] as const,
    };

    const enhanced = buildEnhancedDesignPrompt(brief, 'Create a task list wireframe');

    it('includes the original prompt', () => {
        expect(enhanced).toContain('Create a task list wireframe');
    });

    it('wraps with Design Context section', () => {
        expect(enhanced).toContain('## Design Context');
        expect(enhanced).toContain('Purpose: Track developer tasks');
        expect(enhanced).toContain('Audience: Software engineers');
        expect(enhanced).toContain('Aesthetic: Minimal dark');
    });

    it('includes constraints in context', () => {
        expect(enhanced).toContain('Keyboard accessible');
        expect(enhanced).toContain('WCAG AA');
    });

    it('includes anti-patterns section', () => {
        expect(enhanced).toContain('## Anti-Patterns (DO NOT)');
    });

    it('merges brief anti-patterns with global ANTI_GENERIC_RULES', () => {
        expect(enhanced).toContain('No drag-and-drop');
        for (const rule of ANTI_GENERIC_RULES) {
            expect(enhanced).toContain(rule);
        }
    });

    it('includes inspirations when present', () => {
        expect(enhanced).toContain('Linear');
    });

    it('labels original task section', () => {
        expect(enhanced).toContain('## Original Task');
    });

    it('omits inspirations line when empty', () => {
        const briefNoInspirations = { ...brief, inspirations: [] as const };
        const result = buildEnhancedDesignPrompt(briefNoInspirations, 'wireframe');
        expect(result).not.toContain('Inspirations:');
    });
});
