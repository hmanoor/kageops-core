/**
 * Dependency Manager — unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    DependencyManager,
    extractPackageName,
    extractImports,
    isNodeBuiltin,
} from '../../src/agents/dependency-manager';

// ── Helper: temp repo ───────────────────────────────

function createTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'depman-test-'));
}

function writeFile(repoPath: string, filePath: string, content: string): void {
    const full = path.join(repoPath, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
}

function cleanupDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function writePkgJson(repoPath: string, deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): void {
    const pkg = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: deps,
        devDependencies: devDeps,
    };
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

function readPkgJson(repoPath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'));
}

// ── extractPackageName() ────────────────────────────

describe('extractPackageName()', () => {
    it('returns null for relative imports', () => {
        expect(extractPackageName('./utils')).toBeNull();
        expect(extractPackageName('../lib/helper')).toBeNull();
    });

    it('returns null for absolute paths', () => {
        expect(extractPackageName('/home/user/file')).toBeNull();
    });

    it('extracts regular package name', () => {
        expect(extractPackageName('lodash')).toBe('lodash');
    });

    it('extracts package name from subpath', () => {
        expect(extractPackageName('lodash/get')).toBe('lodash');
    });

    it('extracts scoped package name', () => {
        expect(extractPackageName('@anthropic-ai/sdk')).toBe('@anthropic-ai/sdk');
    });

    it('extracts scoped package name from subpath', () => {
        expect(extractPackageName('@foo/bar/baz')).toBe('@foo/bar');
    });
});

// ── extractImports() ────────────────────────────────

describe('extractImports()', () => {
    it('extracts ES import statements', () => {
        const code = `import { foo } from 'lodash';\nimport express from 'express';`;
        const imports = extractImports(code);
        expect(imports.has('lodash')).toBe(true);
        expect(imports.has('express')).toBe(true);
    });

    it('extracts require calls', () => {
        const code = `const fs = require('fs');\nconst axios = require('axios');`;
        const imports = extractImports(code);
        expect(imports.has('fs')).toBe(true);
        expect(imports.has('axios')).toBe(true);
    });

    it('extracts dynamic imports', () => {
        const code = `const mod = await import('chalk');`;
        const imports = extractImports(code);
        expect(imports.has('chalk')).toBe(true);
    });

    it('ignores relative imports', () => {
        const code = `import { helper } from './utils';`;
        const imports = extractImports(code);
        expect(imports.size).toBe(0);
    });

    it('handles scoped packages', () => {
        const code = `import { Claude } from '@anthropic-ai/sdk';`;
        const imports = extractImports(code);
        expect(imports.has('@anthropic-ai/sdk')).toBe(true);
    });
});

// ── isNodeBuiltin() ─────────────────────────────────

describe('isNodeBuiltin()', () => {
    it('detects common builtins', () => {
        expect(isNodeBuiltin('fs')).toBe(true);
        expect(isNodeBuiltin('path')).toBe(true);
        expect(isNodeBuiltin('crypto')).toBe(true);
        expect(isNodeBuiltin('child_process')).toBe(true);
    });

    it('detects node: prefixed builtins', () => {
        expect(isNodeBuiltin('node:fs')).toBe(true);
        expect(isNodeBuiltin('node:path')).toBe(true);
    });

    it('returns false for npm packages', () => {
        expect(isNodeBuiltin('express')).toBe(false);
        expect(isNodeBuiltin('lodash')).toBe(false);
    });
});

// ── DependencyManager.findMissingDeps() ─────────────

describe('DependencyManager.findMissingDeps()', () => {
    let repoPath: string;
    let dm: DependencyManager;

    beforeEach(() => {
        repoPath = createTempRepo();
        dm = new DependencyManager();
    });

    afterEach(() => {
        cleanupDir(repoPath);
    });

    it('returns empty when no package.json exists', () => {
        writeFile(repoPath, 'src/index.ts', `import express from 'express';`);
        const result = dm.findMissingDeps(repoPath, ['src/index.ts']);
        expect(result).toHaveLength(0);
    });

    it('detects missing dependencies', () => {
        writePkgJson(repoPath);
        writeFile(repoPath, 'src/app.ts', `import express from 'express';\nimport cors from 'cors';`);

        const result = dm.findMissingDeps(repoPath, ['src/app.ts']);
        const names = result.map(d => d.name);
        expect(names).toContain('express');
        expect(names).toContain('cors');
    });

    it('does not report existing dependencies', () => {
        writePkgJson(repoPath, { express: '^4.0.0' });
        writeFile(repoPath, 'src/app.ts', `import express from 'express';`);

        const result = dm.findMissingDeps(repoPath, ['src/app.ts']);
        expect(result).toHaveLength(0);
    });

    it('does not report existing devDependencies', () => {
        writePkgJson(repoPath, {}, { vitest: '^1.0.0' });
        writeFile(repoPath, 'tests/app.test.ts', `import { describe } from 'vitest';`);

        const result = dm.findMissingDeps(repoPath, ['tests/app.test.ts']);
        expect(result).toHaveLength(0);
    });

    it('filters out Node builtins', () => {
        writePkgJson(repoPath);
        writeFile(repoPath, 'src/utils.ts', `import * as fs from 'fs';\nimport * as path from 'path';`);

        const result = dm.findMissingDeps(repoPath, ['src/utils.ts']);
        expect(result).toHaveLength(0);
    });

    it('marks test-only imports as isDev', () => {
        writePkgJson(repoPath);
        writeFile(repoPath, 'tests/app.test.ts', `import supertest from 'supertest';`);

        const result = dm.findMissingDeps(repoPath, ['tests/app.test.ts']);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('supertest');
        expect(result[0].isDev).toBe(true);
    });

    it('marks as non-dev if imported from both test and source', () => {
        writePkgJson(repoPath);
        writeFile(repoPath, 'src/app.ts', `import zod from 'zod';`);
        writeFile(repoPath, 'tests/app.test.ts', `import zod from 'zod';`);

        const result = dm.findMissingDeps(repoPath, ['src/app.ts', 'tests/app.test.ts']);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('zod');
        expect(result[0].isDev).toBe(false);
    });

    it('uses version "*" for all missing deps', () => {
        writePkgJson(repoPath);
        writeFile(repoPath, 'src/app.ts', `import chalk from 'chalk';`);

        const result = dm.findMissingDeps(repoPath, ['src/app.ts']);
        expect(result[0].version).toBe('*');
    });
});

// ── DependencyManager.addToPackageJson() ────────────

describe('DependencyManager.addToPackageJson()', () => {
    let repoPath: string;
    let dm: DependencyManager;

    beforeEach(() => {
        repoPath = createTempRepo();
        dm = new DependencyManager();
    });

    afterEach(() => {
        cleanupDir(repoPath);
    });

    it('adds dependencies to package.json', () => {
        writePkgJson(repoPath, { existing: '^1.0.0' });

        dm.addToPackageJson(repoPath, [
            { name: 'express', version: '*', isDev: false },
        ]);

        const pkg = readPkgJson(repoPath);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps.express).toBe('*');
        expect(deps.existing).toBe('^1.0.0');
    });

    it('adds devDependencies correctly', () => {
        writePkgJson(repoPath);

        dm.addToPackageJson(repoPath, [
            { name: 'vitest', version: '*', isDev: true },
        ]);

        const pkg = readPkgJson(repoPath);
        const devDeps = pkg.devDependencies as Record<string, string>;
        expect(devDeps.vitest).toBe('*');
    });

    it('does not overwrite existing dependencies', () => {
        writePkgJson(repoPath, { express: '^4.18.0' });

        dm.addToPackageJson(repoPath, [
            { name: 'express', version: '*', isDev: false },
        ]);

        const pkg = readPkgJson(repoPath);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps.express).toBe('^4.18.0');
    });

    it('does not add to deps if already in devDeps', () => {
        writePkgJson(repoPath, {}, { lodash: '^4.0.0' });

        dm.addToPackageJson(repoPath, [
            { name: 'lodash', version: '*', isDev: false },
        ]);

        const pkg = readPkgJson(repoPath);
        const deps = pkg.dependencies as Record<string, string>;
        const devDeps = pkg.devDependencies as Record<string, string>;
        expect(deps.lodash).toBeUndefined();
        expect(devDeps.lodash).toBe('^4.0.0');
    });

    it('writes with 2-space indentation and trailing newline', () => {
        writePkgJson(repoPath);
        dm.addToPackageJson(repoPath, [
            { name: 'express', version: '*', isDev: false },
        ]);

        const raw = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');
        expect(raw).toMatch(/^  "/m);  // 2-space indent
        expect(raw.endsWith('\n')).toBe(true);
    });

    it('does nothing for empty deps array', () => {
        writePkgJson(repoPath, { existing: '1.0.0' });
        const before = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');

        dm.addToPackageJson(repoPath, []);

        const after = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');
        expect(after).toBe(before);
    });
});

// ── BPF-11a — never pollute package.json with local paths / bad names ──

describe('BPF-11a — local-path and invalid-name filtering', () => {
    let repoPath: string;
    const dm = new DependencyManager();

    function writeTsconfig(repo: string, paths: Record<string, string[]>): void {
        fs.writeFileSync(
            path.join(repo, 'tsconfig.json'),
            JSON.stringify({ compilerOptions: { paths } }, null, 2),
            'utf-8',
        );
    }

    beforeEach(() => {
        repoPath = createTempRepo();
    });
    afterEach(() => {
        cleanupDir(repoPath);
    });

    it('does NOT treat the @/ tsconfig path alias as an npm package', () => {
        writePkgJson(repoPath);
        writeTsconfig(repoPath, { '@/*': ['./*'] });
        writeFile(repoPath, 'app/page.tsx', "import { Button } from '@/components/ui/button';\nimport { db } from '@/lib/db';\n");

        const missing = dm.findMissingDeps(repoPath, ['app/page.tsx']);

        expect(missing.map(d => d.name)).not.toContain('@/components');
        expect(missing.map(d => d.name)).not.toContain('@/lib');
    });

    it('does NOT treat a bare import of an existing repo dir (src) as a package', () => {
        writePkgJson(repoPath);
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        writeFile(repoPath, 'app/x.ts', "import { thing } from 'src/db';\n");

        const missing = dm.findMissingDeps(repoPath, ['app/x.ts']);

        expect(missing.map(d => d.name)).not.toContain('src');
    });

    it('still detects genuine external packages', () => {
        writePkgJson(repoPath);
        writeTsconfig(repoPath, { '@/*': ['./*'] });
        writeFile(repoPath, 'app/x.ts', "import Stripe from 'stripe';\nimport { z } from 'zod';\nimport { Button } from '@/components/ui/button';\n");

        const names = dm.findMissingDeps(repoPath, ['app/x.ts']).map(d => d.name);

        expect(names).toContain('stripe');
        expect(names).toContain('zod');
        expect(names).not.toContain('@/components');
    });

    it('strips malformed names handed to addToPackageJson and keeps the manifest clean', () => {
        writePkgJson(repoPath, { react: '^18.0.0' });
        dm.addToPackageJson(repoPath, [
            { name: '@/components', version: '*', isDev: false },
            { name: 'src', version: '*', isDev: false },
            { name: 'zod', version: '*', isDev: false },
        ]);

        const pkg = readPkgJson(repoPath);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@/components']).toBeUndefined();
        expect(deps['zod']).toBe('*');
        expect(deps['react']).toBe('^18.0.0');
        // 'src' is a valid npm name format, so addToPackageJson keeps it — the
        // local-dir guard lives in findMissingDeps, not here.
        const raw = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');
        expect(raw).not.toContain('@/components');
    });
});
