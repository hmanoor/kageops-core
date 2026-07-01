/**
 * Wiki Generator — B-219
 * Generates wiki-style documentation from code-review-graph communities.
 */

export interface WikiPage {
  readonly title: string;
  readonly slug: string;
  readonly content: string;
  readonly relatedPages: readonly string[];
}

export interface WikiStructure {
  readonly pages: readonly WikiPage[];
  readonly indexPage: string;
  readonly totalCommunities: number;
}

export interface CommunityInput {
  readonly name: string;
  readonly files: readonly string[];
  readonly cohesion: number;
}

// ---------------------------------------------------------------------------
// generateSlug
// ---------------------------------------------------------------------------

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ---------------------------------------------------------------------------
// buildWikiPrompt
// ---------------------------------------------------------------------------

export function buildWikiPrompt(community: CommunityInput): string {
  const fileList = community.files.map((f) => `  - ${f}`).join('\n');
  return [
    `Generate a wiki page for the code community "${community.name}".`,
    ``,
    `Files in this community (cohesion score: ${community.cohesion.toFixed(2)}):`,
    fileList,
    ``,
    `Please provide the following sections in Markdown:`,
    `1. **Overview** — What this community does and why it exists.`,
    `2. **Key Files & Responsibilities** — Per-file summary of purpose.`,
    `3. **Dependencies** — External or internal modules this community depends on.`,
    `4. **Public API** — Exported functions, classes, or constants.`,
    `5. **Usage Examples** — Short code snippets showing typical usage.`,
    `6. **Architecture Notes** — Design decisions, patterns, and trade-offs.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// buildWikiPageFromCommunity (static, no AI)
// ---------------------------------------------------------------------------

type FileGroup = 'tests' | 'config' | 'typescript' | 'other';

function classifyFile(file: string): FileGroup {
  if (/\.(test|spec)\.[tj]s$/.test(file)) return 'tests';
  if (/\.(json|ya?ml|toml|env|config\.[tj]s)$/.test(file)) return 'config';
  if (/\.[tj]sx?$/.test(file)) return 'typescript';
  return 'other';
}

function groupFiles(
  files: readonly string[],
): Readonly<Record<FileGroup, readonly string[]>> {
  const groups: Record<FileGroup, string[]> = {
    tests: [],
    config: [],
    typescript: [],
    other: [],
  };
  for (const file of files) {
    groups[classifyFile(file)].push(file);
  }
  return groups;
}

function renderGroup(label: string, files: readonly string[]): string {
  if (files.length === 0) return '';
  const items = files.map((f) => `- \`${f}\``).join('\n');
  return `### ${label}\n\n${items}\n`;
}

export function buildWikiPageFromCommunity(community: CommunityInput): WikiPage {
  const title = community.name;
  const slug = generateSlug(community.name);
  const groups = groupFiles(community.files);

  const sections: string[] = [
    `# ${title}`,
    ``,
    `**Cohesion score:** ${community.cohesion.toFixed(2)}  `,
    `**File count:** ${community.files.length}`,
    ``,
    `## Files`,
    ``,
  ];

  const tsSection = renderGroup('TypeScript / JavaScript', groups.typescript);
  const testSection = renderGroup('Tests', groups.tests);
  const configSection = renderGroup('Config', groups.config);
  const otherSection = renderGroup('Other', groups.other);

  if (tsSection) sections.push(tsSection);
  if (testSection) sections.push(testSection);
  if (configSection) sections.push(configSection);
  if (otherSection) sections.push(otherSection);

  const content = sections.join('\n').trimEnd();

  return { title, slug, content, relatedPages: [] };
}

// ---------------------------------------------------------------------------
// linkRelatedPages
// ---------------------------------------------------------------------------

function extractDirectoryPrefixes(files: readonly string[]): ReadonlySet<string> {
  const prefixes = new Set<string>();
  for (const file of files) {
    const parts = file.replace(/\\/g, '/').split('/');
    // require at least 2 segments (e.g. "src/orchestrator") to avoid
    // trivially matching on a single top-level directory like "src"
    for (let i = 2; i < parts.length; i++) {
      prefixes.add(parts.slice(0, i).join('/'));
    }
  }
  return prefixes;
}

function communitiesOverlap(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const prefixesA = extractDirectoryPrefixes(a);
  const prefixesB = extractDirectoryPrefixes(b);
  for (const p of prefixesA) {
    if (prefixesB.has(p)) return true;
  }
  return false;
}

export function linkRelatedPages(
  pages: readonly WikiPage[],
  communities: readonly CommunityInput[],
): readonly WikiPage[] {
  return pages.map((page, i) => {
    const communityA = communities[i];
    if (!communityA) return page;

    const related: string[] = [];
    for (let j = 0; j < pages.length; j++) {
      if (i === j) continue;
      const communityB = communities[j];
      const pageB = pages[j];
      if (!communityB || !pageB) continue;
      if (communitiesOverlap(communityA.files, communityB.files)) {
        related.push(pageB.slug);
      }
    }
    return { ...page, relatedPages: related };
  });
}

// ---------------------------------------------------------------------------
// buildIndexPage
// ---------------------------------------------------------------------------

export function buildIndexPage(pages: readonly WikiPage[]): string {
  const lines: string[] = [
    `# Wiki Index`,
    ``,
    `**${pages.length} page${pages.length === 1 ? '' : 's'}** generated from code communities.`,
    ``,
    `## Pages`,
    ``,
  ];

  for (const page of pages) {
    lines.push(`- [${page.title}](${page.slug}.md)`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// buildWikiStructure
// ---------------------------------------------------------------------------

export function buildWikiStructure(
  communities: readonly CommunityInput[],
): WikiStructure {
  const rawPages = communities.map(buildWikiPageFromCommunity);
  const pages = linkRelatedPages(rawPages, communities);
  const indexPage = buildIndexPage(pages);

  return {
    pages,
    indexPage,
    totalCommunities: communities.length,
  };
}

// ---------------------------------------------------------------------------
// formatWikiOutput
// ---------------------------------------------------------------------------

export function formatWikiOutput(structure: WikiStructure): string {
  const parts: string[] = [
    `--- FILE: docs/wiki/index.md ---`,
    structure.indexPage,
  ];

  for (const page of structure.pages) {
    parts.push(`--- FILE: docs/wiki/${page.slug}.md ---`);
    parts.push(page.content);
  }

  return parts.join('\n\n');
}
