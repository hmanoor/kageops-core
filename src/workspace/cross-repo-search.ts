export interface SearchMatch {
  readonly repoPath: string;
  readonly filePath: string;
  readonly line: number;
  readonly content: string;
  readonly context: string;
}

export interface CrossRepoSearchResult {
  readonly query: string;
  readonly matches: readonly SearchMatch[];
  readonly repoCount: number;
  readonly totalMatches: number;
  readonly searchDuration: number;
}

export interface DependencyMatch {
  readonly repoPath: string;
  readonly packageName: string;
  readonly version: string;
  readonly isDev: boolean;
}

export interface CrossRepoDependencyResult {
  readonly packageName: string;
  readonly usedIn: readonly DependencyMatch[];
  readonly versionConflicts: boolean;
}

export function parsePackageJson(
  content: string
): { dependencies: Record<string, string>; devDependencies: Record<string, string> } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const dependencies =
      parsed['dependencies'] && typeof parsed['dependencies'] === 'object'
        ? (parsed['dependencies'] as Record<string, string>)
        : {};
    const devDependencies =
      parsed['devDependencies'] && typeof parsed['devDependencies'] === 'object'
        ? (parsed['devDependencies'] as Record<string, string>)
        : {};
    return { dependencies, devDependencies };
  } catch {
    return { dependencies: {}, devDependencies: {} };
  }
}

export function searchAcrossRepos(
  repoPaths: readonly string[],
  pattern: RegExp,
  fileGlob: string,
  listFilesFn: (repo: string, glob: string) => string[],
  readFileFn: (repo: string, file: string) => string
): CrossRepoSearchResult {
  const start = Date.now();
  const matches: SearchMatch[] = [];

  for (const repoPath of repoPaths) {
    let files: string[];
    try {
      files = listFilesFn(repoPath, fileGlob);
    } catch {
      files = [];
    }

    for (const filePath of files) {
      let fileContent: string;
      try {
        fileContent = readFileFn(repoPath, filePath);
      } catch {
        continue;
      }

      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pattern.test(line)) {
          const before = i > 0 ? lines[i - 1] : '';
          const after = i < lines.length - 1 ? lines[i + 1] : '';
          const contextParts = [before, after].filter((l) => l !== '');
          const context = contextParts.join('\n');

          matches.push({
            repoPath,
            filePath,
            line: i + 1,
            content: line,
            context,
          });
        }
      }
    }
  }

  return {
    query: pattern.source,
    matches,
    repoCount: repoPaths.length,
    totalMatches: matches.length,
    searchDuration: Date.now() - start,
  };
}

export function findSharedDependencies(
  repoPaths: readonly string[],
  readFileFn: (repo: string, file: string) => string
): readonly CrossRepoDependencyResult[] {
  const packageMap = new Map<string, DependencyMatch[]>();

  for (const repoPath of repoPaths) {
    let content: string;
    try {
      content = readFileFn(repoPath, 'package.json');
    } catch {
      continue;
    }

    const { dependencies, devDependencies } = parsePackageJson(content);

    for (const [pkg, version] of Object.entries(dependencies)) {
      const existing = packageMap.get(pkg) ?? [];
      packageMap.set(pkg, [
        ...existing,
        { repoPath, packageName: pkg, version, isDev: false },
      ]);
    }

    for (const [pkg, version] of Object.entries(devDependencies)) {
      const existing = packageMap.get(pkg) ?? [];
      packageMap.set(pkg, [
        ...existing,
        { repoPath, packageName: pkg, version, isDev: true },
      ]);
    }
  }

  const results: CrossRepoDependencyResult[] = [];

  for (const [packageName, usedIn] of packageMap.entries()) {
    if (usedIn.length < 2) continue;

    const versions = new Set(usedIn.map((d) => d.version));
    const versionConflicts = versions.size > 1;

    results.push({ packageName, usedIn, versionConflicts });
  }

  return results;
}

export function findPatternAcrossRepos(
  repoPaths: readonly string[],
  pattern: string,
  listFilesFn: (repo: string, glob: string) => string[],
  readFileFn: (repo: string, file: string) => string
): CrossRepoSearchResult {
  const regex = new RegExp(pattern);
  return searchAcrossRepos(
    repoPaths,
    regex,
    '**/*.{ts,tsx,js,jsx}',
    listFilesFn,
    readFileFn
  );
}

export function formatSearchReport(result: CrossRepoSearchResult): string {
  const lines: string[] = [];
  lines.push(`# Cross-Repo Search Report`);
  lines.push('');
  lines.push(`**Query:** \`${result.query}\``);
  lines.push(`**Repos searched:** ${result.repoCount}`);
  lines.push(`**Total matches:** ${result.totalMatches}`);
  lines.push(`**Duration:** ${result.searchDuration}ms`);
  lines.push('');

  if (result.totalMatches === 0) {
    lines.push('No matches found.');
    return lines.join('\n');
  }

  const byRepo = new Map<string, SearchMatch[]>();
  for (const match of result.matches) {
    const existing = byRepo.get(match.repoPath) ?? [];
    byRepo.set(match.repoPath, [...existing, match]);
  }

  for (const [repoPath, repoMatches] of byRepo.entries()) {
    lines.push(`## ${repoPath}`);
    lines.push('');
    lines.push(`${repoMatches.length} match(es)`);
    lines.push('');

    for (const match of repoMatches) {
      lines.push(`- **${match.filePath}:${match.line}**`);
      lines.push(`  \`\`\``);
      lines.push(`  ${match.content.trim()}`);
      lines.push(`  \`\`\``);
    }

    lines.push('');
  }

  return lines.join('\n');
}

export function formatDependencyReport(
  results: readonly CrossRepoDependencyResult[]
): string {
  const lines: string[] = [];
  lines.push('# Cross-Repo Shared Dependencies');
  lines.push('');

  if (results.length === 0) {
    lines.push('No shared dependencies found.');
    return lines.join('\n');
  }

  const conflicts = results.filter((r) => r.versionConflicts);
  if (conflicts.length > 0) {
    lines.push(`> **Warning:** ${conflicts.length} package(s) have version conflicts.`);
    lines.push('');
  }

  lines.push('| Package | Repo | Version | Dev |');
  lines.push('|---------|------|---------|-----|');

  for (const result of results) {
    const conflict = result.versionConflicts ? ' ⚠️' : '';
    for (const dep of result.usedIn) {
      lines.push(
        `| ${dep.packageName}${conflict} | ${dep.repoPath} | ${dep.version} | ${dep.isDev ? 'yes' : 'no'} |`
      );
    }
  }

  return lines.join('\n');
}
