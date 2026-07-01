import { describe, it, expect } from 'vitest';
import {
    buildAgentSystemPrompt,
    CAVEMAN_AGENT_RULES,
    CAVEMAN_REVIEW_FORMAT,
} from '../../src/agents/caveman-mode';

describe('caveman-mode', () => {
    const BASE_PROMPT = 'You are Scout, a research specialist agent.';

    describe('buildAgentSystemPrompt', () => {
        it('appends caveman rules when isHumanFacing is false', () => {
            const result = buildAgentSystemPrompt(BASE_PROMPT, false);
            expect(result).toContain(BASE_PROMPT);
            expect(result).toContain(CAVEMAN_AGENT_RULES);
            expect(result.indexOf(BASE_PROMPT)).toBeLessThan(
                result.indexOf(CAVEMAN_AGENT_RULES)
            );
        });

        it('returns base prompt unchanged when isHumanFacing is true', () => {
            const result = buildAgentSystemPrompt(BASE_PROMPT, true);
            expect(result).toBe(BASE_PROMPT);
        });

        it('handles empty base prompt', () => {
            const result = buildAgentSystemPrompt('', false);
            expect(result).toContain(CAVEMAN_AGENT_RULES);
        });
    });

    describe('CAVEMAN_AGENT_RULES', () => {
        it('is defined and non-empty', () => {
            expect(CAVEMAN_AGENT_RULES).toBeDefined();
            expect(CAVEMAN_AGENT_RULES.length).toBeGreaterThan(0);
        });

        it('contains key phrases about terse communication', () => {
            expect(CAVEMAN_AGENT_RULES).toContain('Drop articles');
            expect(CAVEMAN_AGENT_RULES).toContain('No pleasantries');
            expect(CAVEMAN_AGENT_RULES).toContain('Drop filler');
            expect(CAVEMAN_AGENT_RULES).toContain('technical substance');
        });
    });

    describe('CAVEMAN_REVIEW_FORMAT', () => {
        it('is defined and non-empty', () => {
            expect(CAVEMAN_REVIEW_FORMAT).toBeDefined();
            expect(CAVEMAN_REVIEW_FORMAT.length).toBeGreaterThan(0);
        });

        it('contains severity level definitions', () => {
            expect(CAVEMAN_REVIEW_FORMAT).toContain('RED');
            expect(CAVEMAN_REVIEW_FORMAT).toContain('YLW');
            expect(CAVEMAN_REVIEW_FORMAT).toContain('BLU');
            expect(CAVEMAN_REVIEW_FORMAT).toContain('QST');
        });
    });
});
