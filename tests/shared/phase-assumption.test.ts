/**
 * Phase-assumption contract tests.
 *
 * The failure being defended against: an agent doing hours of confident,
 * internally-correct work on a false premise. A budget cap never sees it,
 * because every step looks reasonable. The defence is a gate that carries a
 * claim the operator can disagree with — so these pin that the claim survives
 * parsing intact, and that a garbled one is rejected rather than shown.
 */
import { describe, it, expect } from 'vitest';
import {
    buildAssumptionPrompt,
    parseAssumption,
    formatAssumptionForHuman,
    warrantsReview,
} from '../../src/shared/phase-assumption';

const GOOD = [
    'CLAIM: The client wants a server-rendered site rather than a SPA',
    'IF_WRONG: The entire routing and data-fetching layer is wasted work',
    'CONFIDENCE: medium',
    'BASIS: inferred',
].join('\n');

describe('buildAssumptionPrompt', () => {
    it('asks for ONE assumption, not a list — open prompts produce hedging', () => {
        const p = buildAssumptionPrompt('design-planning', 'built a wireframe');
        expect(p).toContain('ONE assumption');
        expect(p).toContain('Not a list');
    });

    it('forces a falsifiable claim rather than a platitude', () => {
        const p = buildAssumptionPrompt('design-planning', 'x');
        expect(p).toContain('a human could disagree with');
        expect(p).toContain('Do not hedge');
    });

    it('applies the cost test — a costless assumption is the wrong one to state', () => {
        const p = buildAssumptionPrompt('poc', 'x');
        expect(p).toContain('would cost nothing, it is the wrong one');
    });

    it('names the phase and includes the work summary', () => {
        const p = buildAssumptionPrompt('business-viability', 'ran a market scan');
        expect(p).toContain('business-viability');
        expect(p).toContain('ran a market scan');
    });
});

describe('parseAssumption', () => {
    it('extracts every field from a well-formed response', () => {
        const a = parseAssumption(GOOD, 'design-planning');
        expect(a).not.toBeNull();
        expect(a?.claim).toBe('The client wants a server-rendered site rather than a SPA');
        expect(a?.ifWrong).toBe('The entire routing and data-fetching layer is wasted work');
        expect(a?.confidence).toBe('medium');
        expect(a?.basis).toBe('inferred');
        expect(a?.phase).toBe('design-planning');
    });

    it('returns null when the claim is missing — a garbled gate trains click-through', () => {
        expect(parseAssumption('IF_WRONG: something\nCONFIDENCE: high', 'poc')).toBeNull();
    });

    it('returns null when the consequence is missing', () => {
        expect(parseAssumption('CLAIM: something', 'poc')).toBeNull();
    });

    it('returns null on a model that ignored the format entirely', () => {
        expect(parseAssumption('I assume the user wants a good website!', 'poc')).toBeNull();
    });

    it('tolerates case and surrounding prose from a chatty model', () => {
        const messy = [
            'Sure! Here is my assessment:',
            'claim: Payments must clear before dispatch',
            'if_wrong: The whole order pipeline is sequenced incorrectly',
            'confidence: LOW',
            'basis: Brief',
        ].join('\n');
        const a = parseAssumption(messy, 'development');
        expect(a?.claim).toBe('Payments must clear before dispatch');
        expect(a?.confidence).toBe('low');
        expect(a?.basis).toBe('brief');
    });

    it('defaults an unparseable confidence to medium rather than guessing high', () => {
        const a = parseAssumption(
            'CLAIM: x\nIF_WRONG: y\nCONFIDENCE: extremely sure\nBASIS: nonsense',
            'poc',
        );
        // Never silently upgrade to 'high' — that would suppress review.
        expect(a?.confidence).toBe('medium');
        expect(a?.basis).toBe('inferred');
    });
});

describe('warrantsReview', () => {
    const base = { claim: 'c', ifWrong: 'w', phase: 'poc' } as const;

    it('flags low confidence', () => {
        expect(warrantsReview({ ...base, confidence: 'low', basis: 'brief' })).toBe(true);
    });

    it('flags a guess the agent invented rather than read from the brief', () => {
        expect(warrantsReview({ ...base, confidence: 'medium', basis: 'inferred' })).toBe(true);
    });

    it('does not flag a high-confidence claim taken straight from the brief', () => {
        expect(warrantsReview({ ...base, confidence: 'high', basis: 'brief' })).toBe(false);
    });

    it('does not flag a high-confidence inference', () => {
        expect(warrantsReview({ ...base, confidence: 'high', basis: 'inferred' })).toBe(false);
    });
});

describe('formatAssumptionForHuman', () => {
    it('leads with the claim, because the claim is what is being approved', () => {
        const a = parseAssumption(GOOD, 'design-planning')!;
        expect(formatAssumptionForHuman(a).startsWith('Assumes: The client wants')).toBe(true);
    });

    it('states the cost of being wrong and where the claim came from', () => {
        const a = parseAssumption(GOOD, 'design-planning')!;
        const out = formatAssumptionForHuman(a);
        expect(out).toContain('if wrong, The entire routing');
        expect(out).toContain('confidence: medium');
        expect(out).toContain('from: inferred');
    });
});
