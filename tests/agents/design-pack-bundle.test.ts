/**
 * Bundle design context (PR-4) — Tailwind/shadcn discipline for the bundle path.
 *
 * The static-HTML pack forbids Tailwind and ships a vanilla tokens.css; the
 * bundle variant must keep the DISCIPLINE while embracing the bundle's stack.
 */

import { describe, it, expect } from 'vitest';
import {
    BUNDLE_DESIGN_PROMPT,
    buildBundleDesignContext,
    BASE_DESIGN_PROMPT,
} from '../../src/agents/design/design-pack';

describe('BUNDLE_DESIGN_PROMPT', () => {
    it('embraces the bundle stack (Tailwind + shadcn) rather than forbidding it', () => {
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/Tailwind \+ shadcn/);
        // The static pack forbids Tailwind utility classes; the bundle pack must NOT.
        expect(BUNDLE_DESIGN_PROMPT).not.toMatch(/NO Bootstrap \/ Tailwind/);
        expect(BASE_DESIGN_PROMPT).toMatch(/Tailwind/); // sanity: the static pack does mention/forbid it
    });

    it('routes brand colour through the scaffold semantic tokens, not ad-hoc literals', () => {
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/globals\.css/);
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/--primary/);
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/bg-primary|text-muted-foreground|border-border/);
        // Forbids hardcoded colour literals in components.
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/bg-\[#/);
    });

    it('keeps the restraint discipline (one accent, hairline borders, no heavy shadows)', () => {
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/restraint/i);
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/shadow/i);
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/ONE accent|one accent/);
    });

    it('derives the palette from the brief', () => {
        expect(BUNDLE_DESIGN_PROMPT).toMatch(/derive from the brief|derive the brand palette/i);
    });
});

describe('buildBundleDesignContext()', () => {
    it('wraps the bundle prompt with a design-system header', () => {
        const ctx = buildBundleDesignContext();
        expect(ctx).toMatch(/--- DESIGN SYSTEM \(Tailwind \+ shadcn/);
        expect(ctx).toContain(BUNDLE_DESIGN_PROMPT);
    });

    it('does NOT ship the vanilla tokens.css skeleton (the bundle has its own globals.css)', () => {
        expect(buildBundleDesignContext()).not.toContain('TODO_FROM_BRIEF');
    });
});
