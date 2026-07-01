/**
 * F-392 part (a) — `parseEnvDurationMs` strict env parsing for
 * `KAGEOPS_MAX_TASK_DURATION_MS`.
 *
 * Driven by 2026-05-21 GPS Delivery Tracker smoke where a single
 * 16.8-minute Forge task drained the per-run wall-clock budget,
 * starving the build/acceptance gates. The new env lets operators
 * tighten per-task duration on paid presets (e.g. 10 min) so the
 * fallback chain takes over for a slow agent instead of monopolising
 * the run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseEnvDurationMs } from '../../src/agents/autonaut-agent';

describe('parseEnvDurationMs() — F-392', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it('returns fallback when env var is undefined', () => {
        expect(parseEnvDurationMs(undefined, 1_200_000)).toBe(1_200_000);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns fallback when env var is empty string', () => {
        expect(parseEnvDurationMs('', 1_200_000)).toBe(1_200_000);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('parses a valid positive integer', () => {
        expect(parseEnvDurationMs('600000', 1_200_000)).toBe(600_000);
        expect(parseEnvDurationMs('900000', 1_200_000)).toBe(900_000);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('accepts the exact floor (1000ms)', () => {
        expect(parseEnvDurationMs('1000', 1_200_000)).toBe(1000);
    });

    it('rejects values below the 1s floor with a warning', () => {
        expect(parseEnvDurationMs('999', 1_200_000)).toBe(1_200_000);
        expect(parseEnvDurationMs('0', 1_200_000)).toBe(1_200_000);
        expect(parseEnvDurationMs('-100', 1_200_000)).toBe(1_200_000);
        expect(warnSpy).toHaveBeenCalledTimes(3);
        expect(warnSpy).toHaveBeenLastCalledWith(
            expect.stringContaining('KAGEOPS_MAX_TASK_DURATION_MS=-100'),
        );
    });

    it('rejects non-numeric strings with a warning', () => {
        expect(parseEnvDurationMs('abc', 1_200_000)).toBe(1_200_000);
        expect(parseEnvDurationMs('1m', 1_200_000)).toBe(1_200_000);
        // "1m" parses to 1, which fails the floor — same warn path
        expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('rejects floats (parseInt truncates, then floor check kicks in if needed)', () => {
        // 1500.7 → parseInt → 1500 → passes the 1000 floor
        expect(parseEnvDurationMs('1500.7', 1_200_000)).toBe(1500);
        // 0.5 → parseInt → 0 → fails the floor → fallback
        expect(parseEnvDurationMs('0.5', 1_200_000)).toBe(1_200_000);
    });

    it('warning message includes both the bad value and the fallback', () => {
        parseEnvDurationMs('999', 1_200_000);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('999'),
        );
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('1200000ms'),
        );
    });
});
