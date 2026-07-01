/**
 * G2 — content grounding (no fabricated domain facts).
 *
 * The MCC build shipped fabricated fees, an address, member counts, and
 * tournament dates. Static checks can't catch plausible fabrication, so the fix
 * is a grounding directive in the content/data specialists' system prompts.
 * These tests lock in that the directive exists, is wired into the right agents,
 * and is NOT bloating agents that don't emit user-facing facts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    GROUNDING_DIRECTIVE,
    GROUNDING_MARKER,
    withGrounding,
} from '../../src/agents/grounding';
import type { AgentModelConfig } from '../../src/agents/autonaut-agent';

import { Scout } from '../../src/agents/specialists/scout';
import { Herald } from '../../src/agents/specialists/herald';
import { Pixel } from '../../src/agents/specialists/pixel';
import { Cipher } from '../../src/agents/specialists/cipher';
import { Forge } from '../../src/agents/specialists/forge';
import { Blueprint } from '../../src/agents/specialists/blueprint';
import { Vigil } from '../../src/agents/specialists/vigil';
import { Aegis } from '../../src/agents/specialists/aegis';

const CFG: AgentModelConfig = { model: 'claude/claude-sonnet-4-20250514' };

describe('GROUNDING_DIRECTIVE', () => {
    it('carries the marker and the key rules', () => {
        expect(GROUNDING_DIRECTIVE).toContain(GROUNDING_MARKER);
        expect(GROUNDING_DIRECTIVE).toContain('SURFACE THE GAP');
        expect(GROUNDING_DIRECTIVE).toMatch(/prices|fees/);
        expect(GROUNDING_DIRECTIVE).toContain('addresses');
        expect(GROUNDING_DIRECTIVE).toContain('seed data');
    });

    it('withGrounding appends the directive to a base prompt', () => {
        const out = withGrounding('You are Test.');
        expect(out.startsWith('You are Test.')).toBe(true);
        expect(out).toContain(GROUNDING_MARKER);
    });
});

describe('content/data specialists carry the grounding directive', () => {
    it.each([
        ['Scout', new Scout(CFG)],
        ['Herald', new Herald(CFG)],
        ['Pixel', new Pixel(CFG)],
        ['Cipher', new Cipher(CFG)],
        ['Forge', new Forge(CFG)],
    ])('%s system prompt includes the grounding marker', (_name, agent) => {
        expect(agent.systemPrompt).toContain(GROUNDING_MARKER);
    });
});

describe('non-content agents do NOT carry the directive (targeted injection)', () => {
    it.each([
        ['Blueprint', new Blueprint(CFG)],
        ['Vigil', new Vigil(CFG)],
        ['Aegis', new Aegis(CFG)],
    ])('%s system prompt omits the grounding marker', (_name, agent) => {
        expect(agent.systemPrompt).not.toContain(GROUNDING_MARKER);
    });
});

describe('nextjs-saas create-ui prompt forbids fabricated copy', () => {
    it('includes the no-fabrication clause', () => {
        const prompt = fs.readFileSync(
            path.resolve(__dirname, '..', '..', 'bundles', 'stacks', 'nextjs-saas', 'prompts', 'forge-create-ui.md'),
            'utf-8',
        );
        expect(prompt).toContain('NO FABRICATED FACTS');
        expect(prompt).toContain('[TODO: confirm pricing]');
    });
});
