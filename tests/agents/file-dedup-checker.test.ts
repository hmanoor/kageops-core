/**
 * File Deduplication Checker — unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    FileDedupChecker,
    filenameSimilarity,
    extractExports,
    extractKeywords,
    setOverlap,
} from '../../src/agents/file-dedup-checker';

// ── Helper: create temp repo ────────────────────────

function createTempRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
    return dir;
}

function writeFile(repoPath: string, filePath: string, content: string): void {
    const full = path.join(repoPath, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
}

function cleanupDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── filenameSimilarity() ────────────────────────────

describe('filenameSimilarity()', () => {
    it('returns 1.0 for identical basenames', () => {
        expect(filenameSimilarity('src/discovery.ts', 'lib/discovery.ts')).toBe(1);
    });

    it('returns high similarity for similar names', () => {
        const sim = filenameSimilarity('discovery.ts', 'lan-discovery.ts');
        expect(sim).toBeGreaterThan(0.5);
    });

    it('returns low similarity for different names', () => {
        const sim = filenameSimilarity('auth-controller.ts', 'database-client.ts');
        expect(sim).toBeLessThan(0.4);
    });

    it('handles empty basenames gracefully', () => {
        expect(filenameSimilarity('.ts', '.ts')).toBe(1);
    });
});

// ── extractExports() ────────────────────────────────

describe('extractExports()', () => {
    it('extracts class exports', () => {
        const exports = extractExports('export class MyService {}');
        expect(exports.has('MyService')).toBe(true);
    });

    it('extracts function exports', () => {
        const exports = extractExports('export function doStuff() {}');
        expect(exports.has('doStuff')).toBe(true);
    });

    it('extracts multiple export types', () => {
        const code = [
            'export class Foo {}',
            'export interface Bar {}',
            'export type Baz = string;',
            'export const QUX = 1;',
            'export enum Status {}',
        ].join('\n');

        const exports = extractExports(code);
        expect(exports.size).toBe(5);
        expect(exports.has('Foo')).toBe(true);
        expect(exports.has('Bar')).toBe(true);
        expect(exports.has('Baz')).toBe(true);
        expect(exports.has('QUX')).toBe(true);
        expect(exports.has('Status')).toBe(true);
    });

    it('returns empty set for no exports', () => {
        const exports = extractExports('const x = 1;');
        expect(exports.size).toBe(0);
    });
});

// ── extractKeywords() ────────────────────────────────

describe('extractKeywords()', () => {
    it('extracts PascalCase identifiers', () => {
        const kw = extractKeywords('class DiscoveryService extends BaseService {}');
        expect(kw.has('DiscoveryService')).toBe(true);
        expect(kw.has('BaseService')).toBe(true);
    });

    it('extracts camelCase identifiers 4+ chars', () => {
        const kw = extractKeywords('const findDevices = () => networkScan();');
        expect(kw.has('findDevices')).toBe(true);
        expect(kw.has('networkScan')).toBe(true);
    });

    it('ignores short identifiers', () => {
        const kw = extractKeywords('const foo = bar + baz;');
        expect(kw.has('foo')).toBe(false);
        expect(kw.has('bar')).toBe(false);
    });
});

// ── setOverlap() ────────────────────────────────────

describe('setOverlap()', () => {
    it('returns 1 for identical sets', () => {
        const s = new Set(['a', 'b', 'c']);
        expect(setOverlap(s, s)).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
        expect(setOverlap(new Set(['a']), new Set(['b']))).toBe(0);
    });

    it('returns 0 for two empty sets', () => {
        expect(setOverlap(new Set(), new Set())).toBe(0);
    });

    it('computes partial overlap correctly', () => {
        const a = new Set(['x', 'y', 'z']);
        const b = new Set(['y', 'z', 'w']);
        // intersection = 2, minSize = 3
        expect(setOverlap(a, b)).toBeCloseTo(2 / 3);
    });
});

// ── FileDedupChecker.checkForDuplicate() ────────────

describe('FileDedupChecker.checkForDuplicate()', () => {
    let repoPath: string;
    let checker: FileDedupChecker;

    beforeEach(() => {
        repoPath = createTempRepo();
        checker = new FileDedupChecker();
    });

    afterEach(() => {
        cleanupDir(repoPath);
    });

    it('returns write for a completely new file in empty repo', () => {
        const result = checker.checkForDuplicate(repoPath, 'src/auth.ts', 'export class AuthService {}');
        expect(result.recommendation).toBe('write');
        expect(result.hasDuplicate).toBe(false);
    });

    it('returns skip for a near-identical file', () => {
        const existingContent = [
            'export class DiscoveryService {',
            '    findDevices(): string[] { return []; }',
            '    scanNetwork(): void {}',
            '}',
        ].join('\n');

        const newContent = [
            'export class DiscoveryService {',
            '    findDevices(): string[] { return ["device1"]; }',
            '    scanNetwork(): void { /* updated */ }',
            '}',
        ].join('\n');

        writeFile(repoPath, 'src/discovery.ts', existingContent);

        const result = checker.checkForDuplicate(repoPath, 'src/lan-discovery.ts', newContent);
        expect(result.similarity).toBeGreaterThanOrEqual(0.82);
        expect(result.recommendation).toBe('skip');
        expect(result.hasDuplicate).toBe(true);
    });

    it('returns merge for partially overlapping files', () => {
        // Files share two exports and several keywords, with a related
        // (but not identical) filename — similarity lands in [0.65, 0.82).
        const existingContent = [
            'export function initScanner(port: number): void {}',
            'export interface ScannerConfig { timeout: number; retries: number; }',
            'export class NetworkScanner {',
            '    configureNetwork(config: ScannerConfig): void {}',
            '    startScan(targets: string[]): void {}',
            '}',
        ].join('\n');

        const newContent = [
            'export function initScanner(port: number): void {}',
            'export interface ScannerConfig { timeout: number; retries: number; verbose: boolean; }',
            'export class AdvancedScanner {',
            '    configureNetwork(config: ScannerConfig): void {}',
            '    runDeepScan(): string[] { return []; }',
            '    exportResults(): void {}',
            '}',
        ].join('\n');

        writeFile(repoPath, 'src/scanner-utils.ts', existingContent);

        const result = checker.checkForDuplicate(repoPath, 'src/scanner-helpers.ts', newContent);
        // 2/3 shared exports + shared keywords + similar filename → merge range
        expect(result.similarity).toBeGreaterThanOrEqual(0.65);
        expect(result.similarity).toBeLessThan(0.82);
        expect(result.recommendation).toBe('merge');
    });

    it('returns write for completely different files', () => {
        writeFile(repoPath, 'src/auth.ts', 'export class AuthService { login() {} logout() {} }');

        const result = checker.checkForDuplicate(
            repoPath,
            'src/database.ts',
            'export class DatabaseClient { connect() {} query() {} }'
        );

        expect(result.recommendation).toBe('write');
        expect(result.hasDuplicate).toBe(false);
    });

    it('does not compare file against itself', () => {
        writeFile(repoPath, 'src/utils.ts', 'export function helper() {}');

        const result = checker.checkForDuplicate(
            repoPath,
            'src/utils.ts',
            'export function helper() {}'
        );

        expect(result.recommendation).toBe('write');
    });

    it('skips node_modules and .git directories', () => {
        writeFile(repoPath, 'node_modules/pkg/discovery.ts', 'export class DiscoveryService {}');
        writeFile(repoPath, '.git/objects/discovery.ts', 'export class DiscoveryService {}');

        const result = checker.checkForDuplicate(
            repoPath,
            'src/discovery.ts',
            'export class DiscoveryService { findDevices() {} }'
        );

        expect(result.recommendation).toBe('write');
    });
});
