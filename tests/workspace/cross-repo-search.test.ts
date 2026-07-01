import { describe, it, expect } from 'vitest';
import {
  searchAcrossRepos,
  parsePackageJson,
  findSharedDependencies,
  findPatternAcrossRepos,
  formatSearchReport,
  formatDependencyReport,
} from '../../src/workspace/cross-repo-search';

const makeListFiles =
  (map: Record<string, string[]>) =>
  (repo: string, _glob: string): string[] =>
    map[repo] ?? [];

const makeReadFile =
  (map: Record<string, Record<string, string>>) =>
  (repo: string, file: string): string => {
    const content = map[repo]?.[file];
    if (content === undefined) throw new Error(`File not found: ${repo}/${file}`);
    return content;
  };

describe('searchAcrossRepos', () => {
  it('finds matches across multiple repos', () => {
    const listFiles = makeListFiles({
      '/repo-a': ['index.ts'],
      '/repo-b': ['utils.ts'],
    });
    const readFile = makeReadFile({
      '/repo-a': { 'index.ts': 'const foo = "hello";\nconst bar = "world";' },
      '/repo-b': { 'utils.ts': 'function hello() {}\nfunction goodbye() {}' },
    });

    const result = searchAcrossRepos(
      ['/repo-a', '/repo-b'],
      /hello/,
      '**/*.ts',
      listFiles,
      readFile
    );

    expect(result.totalMatches).toBe(2);
    expect(result.matches.some((m) => m.repoPath === '/repo-a')).toBe(true);
    expect(result.matches.some((m) => m.repoPath === '/repo-b')).toBe(true);
  });

  it('returns correct line numbers', () => {
    const listFiles = makeListFiles({ '/repo': ['file.ts'] });
    const readFile = makeReadFile({
      '/repo': { 'file.ts': 'line one\ntarget line\nline three' },
    });

    const result = searchAcrossRepos(['/repo'], /target/, '**/*.ts', listFiles, readFile);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].line).toBe(2);
  });

  it('includes context lines', () => {
    const listFiles = makeListFiles({ '/repo': ['file.ts'] });
    const readFile = makeReadFile({
      '/repo': { 'file.ts': 'before\ntarget\nafter' },
    });

    const result = searchAcrossRepos(['/repo'], /target/, '**/*.ts', listFiles, readFile);

    expect(result.matches[0].context).toContain('before');
    expect(result.matches[0].context).toContain('after');
  });

  it('handles empty repos', () => {
    const listFiles = makeListFiles({ '/repo': [] });
    const readFile = makeReadFile({});

    const result = searchAcrossRepos(['/repo'], /anything/, '**/*.ts', listFiles, readFile);

    expect(result.totalMatches).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it('tracks timing', () => {
    const listFiles = makeListFiles({ '/repo': [] });
    const readFile = makeReadFile({});

    const result = searchAcrossRepos(['/repo'], /x/, '**/*.ts', listFiles, readFile);

    expect(typeof result.searchDuration).toBe('number');
    expect(result.searchDuration).toBeGreaterThanOrEqual(0);
  });
});

describe('parsePackageJson', () => {
  it('parses valid JSON', () => {
    const content = JSON.stringify({
      dependencies: { react: '^18.0.0', lodash: '^4.0.0' },
      devDependencies: { vitest: '^1.0.0' },
    });

    const result = parsePackageJson(content);

    expect(result.dependencies['react']).toBe('^18.0.0');
    expect(result.dependencies['lodash']).toBe('^4.0.0');
    expect(result.devDependencies['vitest']).toBe('^1.0.0');
  });

  it('returns empty objects on invalid JSON', () => {
    const result = parsePackageJson('not valid json {{{');

    expect(result.dependencies).toEqual({});
    expect(result.devDependencies).toEqual({});
  });
});

describe('findSharedDependencies', () => {
  it('identifies packages in multiple repos', () => {
    const readFile = makeReadFile({
      '/repo-a': {
        'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      },
      '/repo-b': {
        'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      },
    });

    const results = findSharedDependencies(['/repo-a', '/repo-b'], readFile);

    const reactResult = results.find((r) => r.packageName === 'react');
    expect(reactResult).toBeDefined();
    expect(reactResult?.usedIn).toHaveLength(2);
  });

  it('detects version conflicts', () => {
    const readFile = makeReadFile({
      '/repo-a': {
        'package.json': JSON.stringify({ dependencies: { lodash: '^4.0.0' } }),
      },
      '/repo-b': {
        'package.json': JSON.stringify({ dependencies: { lodash: '^3.0.0' } }),
      },
    });

    const results = findSharedDependencies(['/repo-a', '/repo-b'], readFile);

    const lodashResult = results.find((r) => r.packageName === 'lodash');
    expect(lodashResult?.versionConflicts).toBe(true);
  });

  it('handles missing package.json', () => {
    const readFile = makeReadFile({
      '/repo-a': {
        'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      },
      '/repo-b': {},
    });

    const results = findSharedDependencies(['/repo-a', '/repo-b'], readFile);

    // react only in one repo, should not appear
    const reactResult = results.find((r) => r.packageName === 'react');
    expect(reactResult).toBeUndefined();
  });
});

describe('findPatternAcrossRepos', () => {
  it('searches ts/tsx/js/jsx files', () => {
    const listFiles = (repo: string, glob: string): string[] => {
      expect(glob).toBe('**/*.{ts,tsx,js,jsx}');
      return repo === '/repo' ? ['app.ts', 'component.tsx'] : [];
    };
    const readFile = makeReadFile({
      '/repo': {
        'app.ts': 'const target = 1;',
        'component.tsx': 'const other = 2;',
      },
    });

    const result = findPatternAcrossRepos(['/repo'], 'target', listFiles, readFile);

    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].filePath).toBe('app.ts');
  });
});

describe('formatSearchReport', () => {
  it('groups by repo', () => {
    const result = {
      query: 'foo',
      matches: [
        {
          repoPath: '/repo-a',
          filePath: 'a.ts',
          line: 1,
          content: 'foo',
          context: '',
        },
        {
          repoPath: '/repo-b',
          filePath: 'b.ts',
          line: 5,
          content: 'foo bar',
          context: '',
        },
      ],
      repoCount: 2,
      totalMatches: 2,
      searchDuration: 10,
    };

    const report = formatSearchReport(result);

    expect(report).toContain('/repo-a');
    expect(report).toContain('/repo-b');
    expect(report).toContain('a.ts:1');
    expect(report).toContain('b.ts:5');
  });
});

describe('formatDependencyReport', () => {
  it('shows version conflicts', () => {
    const results = [
      {
        packageName: 'lodash',
        usedIn: [
          { repoPath: '/repo-a', packageName: 'lodash', version: '^4.0.0', isDev: false },
          { repoPath: '/repo-b', packageName: 'lodash', version: '^3.0.0', isDev: false },
        ],
        versionConflicts: true,
      },
    ];

    const report = formatDependencyReport(results);

    expect(report).toContain('lodash');
    expect(report).toContain('Warning');
    expect(report).toContain('^4.0.0');
    expect(report).toContain('^3.0.0');
  });
});
