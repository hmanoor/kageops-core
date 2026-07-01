/**
 * Headless Runner — --resume flag parsing tests for Feature #2.
 *
 * Validates the CLI contract: --resume <uuid> takes precedence over
 * --name/--description, and rejects mutually-exclusive combinations.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/cli/headless-runner';

const VALID_UUID = '221c3f2a-76e5-4644-b064-29c43f2602d5';

describe('Headless Runner — parseArgs() with --resume', () => {
    it('accepts --resume <uuid> alone (no --name required)', () => {
        const args = parseArgs(['--resume', VALID_UUID]);
        expect(args.resume).toBe(VALID_UUID);
        // The synthetic name is fine — the runner will fetch the real one
        // from the projects table at execution time.
        expect(args.name).toContain('resume:');
    });

    it('rejects --resume + --name together (mutually exclusive)', () => {
        expect(() => parseArgs(['--name', 'X', '--resume', VALID_UUID]))
            .toThrow(/mutually exclusive/i);
    });

    it('rejects --resume + --description together (mutually exclusive)', () => {
        expect(() => parseArgs(['--resume', VALID_UUID, '--description', 'foo']))
            .toThrow(/mutually exclusive/i);
    });

    it('rejects --resume with a non-UUID value', () => {
        expect(() => parseArgs(['--resume', 'not-a-uuid']))
            .toThrow(/UUID/i);
    });

    it('still requires --name when --resume is not set', () => {
        expect(() => parseArgs([])).toThrow(/--name is required/i);
    });

    it('does not set resume when --resume is absent', () => {
        const args = parseArgs(['--name', 'Foo', '--description', 'bar']);
        expect(args.resume).toBeNull();
        expect(args.name).toBe('Foo');
    });

    it('preserves other flags alongside --resume (trust, timeout, projects-dir)', () => {
        const args = parseArgs([
            '--resume', VALID_UUID,
            '--trust', 'medium',
            '--timeout', '120000',
            '--projects-dir', 'C:/tmp/projects',
        ]);
        expect(args.resume).toBe(VALID_UUID);
        expect(args.trustLevel).toBe('medium');
        expect(args.timeoutMs).toBe(120_000);
        expect(args.projectsDir).toBe('C:/tmp/projects');
    });
});
