/**
 * Pure project filter tests (B-407).
 */

import { describe, it, expect } from 'vitest';
import { applyProjectFilter, uniqueSorted } from '../../src/renderer/command-center/project-filter';

interface P {
    readonly name: string;
    readonly status: string;
    readonly phase: string;
}

const PROJECTS: readonly P[] = [
    { name: 'Ninja Dashboard',    status: 'active',    phase: 'Development' },
    { name: 'Kage Landing Page',  status: 'active',    phase: 'Design & Planning' },
    { name: 'Pixel Studio',       status: 'paused',    phase: 'Development' },
    { name: 'Old experiment',     status: 'archived',  phase: 'Launch & Growth' },
    { name: 'Scout Prototype',    status: 'completed', phase: 'POC' },
];

describe('applyProjectFilter', () => {
    it('returns the original list unchanged when no criteria are set', () => {
        const out = applyProjectFilter(PROJECTS, {});
        expect(out).toBe(PROJECTS); // identity — no copy when not filtering
    });

    it('treats empty/whitespace-only search as no filter', () => {
        const out = applyProjectFilter(PROJECTS, { search: '   ' });
        expect(out).toBe(PROJECTS);
    });

    it('filters by case-insensitive substring on name', () => {
        const out = applyProjectFilter(PROJECTS, { search: 'NINJA' });
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('Ninja Dashboard');
    });

    it('matches substrings inside the name', () => {
        const out = applyProjectFilter(PROJECTS, { search: 'landing' });
        expect(out.map((p) => p.name)).toEqual(['Kage Landing Page']);
    });

    it('filters by exact status', () => {
        const out = applyProjectFilter(PROJECTS, { status: 'active' });
        expect(out.map((p) => p.name).sort()).toEqual(['Kage Landing Page', 'Ninja Dashboard']);
    });

    it('filters by exact phase', () => {
        const out = applyProjectFilter(PROJECTS, { phase: 'Development' });
        expect(out.map((p) => p.name).sort()).toEqual(['Ninja Dashboard', 'Pixel Studio']);
    });

    it('ANDs search + status + phase together', () => {
        const out = applyProjectFilter(PROJECTS, {
            search: 'ninja',
            status: 'active',
            phase: 'Development',
        });
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('Ninja Dashboard');
    });

    it('returns an empty list when the combined filter matches nothing', () => {
        const out = applyProjectFilter(PROJECTS, {
            search: 'ninja',
            status: 'archived',
        });
        expect(out).toEqual([]);
    });

    it('does not mutate the input list', () => {
        const snapshot = [...PROJECTS];
        applyProjectFilter(PROJECTS, { search: 'ninja', status: 'active' });
        expect(PROJECTS).toEqual(snapshot);
    });

    it('treats search=undefined and status="" as no-op', () => {
        const out = applyProjectFilter(PROJECTS, { search: undefined, status: '', phase: '' });
        expect(out).toBe(PROJECTS);
    });
});

describe('uniqueSorted', () => {
    it('extracts sorted unique statuses', () => {
        expect(uniqueSorted(PROJECTS, 'status')).toEqual(['active', 'archived', 'completed', 'paused']);
    });

    it('extracts sorted unique phases', () => {
        expect(uniqueSorted(PROJECTS, 'phase')).toEqual([
            'Design & Planning',
            'Development',
            'Launch & Growth',
            'POC',
        ]);
    });

    it('returns an empty list when the input is empty', () => {
        expect(uniqueSorted([] as readonly P[], 'status')).toEqual([]);
    });

    it('handles duplicates', () => {
        const many: readonly P[] = [
            { name: 'a', status: 'active', phase: 'x' },
            { name: 'b', status: 'active', phase: 'x' },
            { name: 'c', status: 'active', phase: 'y' },
        ];
        expect(uniqueSorted(many, 'status')).toEqual(['active']);
        expect(uniqueSorted(many, 'phase')).toEqual(['x', 'y']);
    });
});
