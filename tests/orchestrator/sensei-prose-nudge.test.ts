/**
 * F-148 V2 — free-form prose nudge unit tests.
 *
 * Covers the pure `looksLikeRequirementProse()` predicate. The
 * integration with `handleChatMessage` (real Sensei + IPC) is left to
 * the existing add-requirement test suite + the manual smoke runbook
 * at docs/runbooks/smoke-add-requirement.md; here we lock in the
 * heuristic so it doesn't drift.
 *
 * The nudge is intentionally conservative: ONLY trigger when the
 * message is short, imperative, and not a question. False positives
 * (LLM never gets the message) cost the operator a re-type; false
 * negatives (LLM hallucinates dispatch) cost real agent time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { looksLikeRequirementProse } from '../../src/orchestrator/sensei';

describe('looksLikeRequirementProse() — F-148 V2', () => {
    afterEach(() => {
        delete process.env.KAGEOPS_DISABLE_F148_PROSE_NUDGE;
    });

    describe('positive matches', () => {
        it.each([
            'add a contact form to the landing page',
            'Add a CTA button below the hero',
            'implement OAuth login via Google',
            'build a dashboard for invoices',
            'create a new admin panel',
            'make the header sticky on scroll',
            'include analytics on every page view',
            'support dark mode in the settings panel',
            'fix the broken footer link',
            'remove the deprecated /v1 endpoint',
            'update the pricing page copy',
            'change the primary color to teal',
            'rename ScoutAgent to Scout',
            'integrate Stripe for one-time payments',
            'wire up the search filter to the API',
            'hook the new webhook into Sensei',
        ])('matches %j', (msg) => {
            expect(looksLikeRequirementProse(msg)).toBe(true);
        });

        it('strips an @AgentName: mention before classifying', () => {
            expect(looksLikeRequirementProse('@Herald: add a Twitter share button')).toBe(true);
        });
    });

    describe('negative matches — questions', () => {
        it.each([
            'why did Forge fail on task 3?',
            'what is the next phase?',
            'how do I add a requirement?',
            'where is the project saved?',
            'when will Scout finish?',
            'who owns this project?',
            'which agent handles UI work?',
            'is the build green?',
            'can you add a contact form?',
            'could you build a dashboard?',
            'should we use Postgres or SQLite?',
            'would Stripe be a good fit here?',
            'do we have unit tests yet?',
            'does Sensei retry failed tasks?',
            'did the deploy succeed?',
            'add a contact form?',
        ])('does not match %j', (msg) => {
            expect(looksLikeRequirementProse(msg)).toBe(false);
        });
    });

    describe('negative matches — slash already present', () => {
        it.each([
            '/add-requirement add a footer',
            '/add_requirement build admin panel',
            '/add requirement implement search',
            '@Herald: /add-requirement add tweet button',
        ])('does not match %j (defers to slash parser)', (msg) => {
            expect(looksLikeRequirementProse(msg)).toBe(false);
        });
    });

    describe('negative matches — length boundaries', () => {
        it('rejects messages shorter than 8 chars', () => {
            expect(looksLikeRequirementProse('add x')).toBe(false);
            expect(looksLikeRequirementProse('fix it')).toBe(false);
        });

        it('rejects messages longer than 250 chars', () => {
            const longProse = 'add ' + 'a really long detailed feature description '.repeat(20);
            expect(longProse.length).toBeGreaterThan(250);
            expect(looksLikeRequirementProse(longProse)).toBe(false);
        });

        it('accepts a 250-char message at the boundary', () => {
            const padded = 'add ' + 'x'.repeat(246);
            expect(padded.length).toBe(250);
            expect(looksLikeRequirementProse(padded)).toBe(true);
        });
    });

    describe('negative matches — non-imperative first word', () => {
        it.each([
            'the contact form is broken',
            'a contact form would be nice',
            'thanks!',
            'cool — start',
            'ok proceed',
            'yes',
            '...',
            '',
            '   ',
        ])('does not match %j', (msg) => {
            expect(looksLikeRequirementProse(msg)).toBe(false);
        });
    });

    describe('opt-out', () => {
        it('returns false when KAGEOPS_DISABLE_F148_PROSE_NUDGE=1', () => {
            process.env.KAGEOPS_DISABLE_F148_PROSE_NUDGE = '1';
            expect(looksLikeRequirementProse('add a landing page')).toBe(false);
        });

        it('still returns true when the env var is any other value', () => {
            process.env.KAGEOPS_DISABLE_F148_PROSE_NUDGE = '0';
            expect(looksLikeRequirementProse('add a landing page')).toBe(true);
            process.env.KAGEOPS_DISABLE_F148_PROSE_NUDGE = 'false';
            expect(looksLikeRequirementProse('add a landing page')).toBe(true);
        });
    });
});
