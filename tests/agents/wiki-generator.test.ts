import { describe, it, expect } from 'vitest';
import {
  generateSlug,
  buildWikiPrompt,
  buildWikiPageFromCommunity,
  linkRelatedPages,
  buildIndexPage,
  buildWikiStructure,
  formatWikiOutput,
  type CommunityInput,
} from '../../src/agents/wiki-generator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const communityA: CommunityInput = {
  name: 'Event Bus Core',
  files: ['src/orchestrator/event-bus.ts', 'src/orchestrator/sensei.ts'],
  cohesion: 0.87,
};

const communityB: CommunityInput = {
  name: 'Agent Framework',
  files: ['src/agents/autonaut-agent.ts', 'src/agents/agent-registry.ts'],
  cohesion: 0.72,
};

const communityC: CommunityInput = {
  name: 'Orchestrator Utils',
  // shares 'src/orchestrator/' prefix with communityA
  files: ['src/orchestrator/task-router.ts', 'src/orchestrator/phase-gates.ts'],
  cohesion: 0.65,
};

// ---------------------------------------------------------------------------
// generateSlug
// ---------------------------------------------------------------------------

describe('generateSlug', () => {
  it('converts spaces to hyphens', () => {
    expect(generateSlug('Event Bus Core')).toBe('event-bus-core');
  });

  it('strips special characters', () => {
    expect(generateSlug('Agent! @#$% Framework')).toBe('agent-framework');
  });

  it('lowercases the result', () => {
    expect(generateSlug('MyModule')).toBe('mymodule');
  });
});

// ---------------------------------------------------------------------------
// buildWikiPrompt
// ---------------------------------------------------------------------------

describe('buildWikiPrompt', () => {
  it('includes community name', () => {
    const prompt = buildWikiPrompt(communityA);
    expect(prompt).toContain('Event Bus Core');
  });

  it('includes all files', () => {
    const prompt = buildWikiPrompt(communityA);
    for (const file of communityA.files) {
      expect(prompt).toContain(file);
    }
  });
});

// ---------------------------------------------------------------------------
// buildWikiPageFromCommunity
// ---------------------------------------------------------------------------

describe('buildWikiPageFromCommunity', () => {
  it('creates page with correct title', () => {
    const page = buildWikiPageFromCommunity(communityA);
    expect(page.title).toBe('Event Bus Core');
  });

  it('creates page with correct slug', () => {
    const page = buildWikiPageFromCommunity(communityA);
    expect(page.slug).toBe('event-bus-core');
  });

  it('lists files in content', () => {
    const page = buildWikiPageFromCommunity(communityA);
    for (const file of communityA.files) {
      expect(page.content).toContain(file);
    }
  });

  it('includes cohesion score in content', () => {
    const page = buildWikiPageFromCommunity(communityA);
    expect(page.content).toContain('0.87');
  });
});

// ---------------------------------------------------------------------------
// linkRelatedPages
// ---------------------------------------------------------------------------

describe('linkRelatedPages', () => {
  it('finds pages sharing directory prefixes', () => {
    const rawPages = [communityA, communityC].map(buildWikiPageFromCommunity);
    const linked = linkRelatedPages(rawPages, [communityA, communityC]);
    // A and C both live under src/orchestrator/
    expect(linked[0]?.relatedPages).toContain('orchestrator-utils');
    expect(linked[1]?.relatedPages).toContain('event-bus-core');
  });

  it('returns empty relatedPages when no overlap', () => {
    const rawPages = [communityA, communityB].map(buildWikiPageFromCommunity);
    const linked = linkRelatedPages(rawPages, [communityA, communityB]);
    // A is in src/orchestrator/, B is in src/agents/ — no shared prefix
    expect(linked[0]?.relatedPages).toHaveLength(0);
    expect(linked[1]?.relatedPages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildIndexPage
// ---------------------------------------------------------------------------

describe('buildIndexPage', () => {
  it('includes all page titles', () => {
    const pages = [communityA, communityB].map(buildWikiPageFromCommunity);
    const index = buildIndexPage(pages);
    expect(index).toContain('Event Bus Core');
    expect(index).toContain('Agent Framework');
  });

  it('includes page count', () => {
    const pages = [communityA, communityB].map(buildWikiPageFromCommunity);
    const index = buildIndexPage(pages);
    expect(index).toContain('2');
  });
});

// ---------------------------------------------------------------------------
// buildWikiStructure
// ---------------------------------------------------------------------------

describe('buildWikiStructure', () => {
  it('creates correct number of pages', () => {
    const structure = buildWikiStructure([communityA, communityB, communityC]);
    expect(structure.pages).toHaveLength(3);
    expect(structure.totalCommunities).toBe(3);
  });

  it('builds index page', () => {
    const structure = buildWikiStructure([communityA, communityB]);
    expect(structure.indexPage).toBeTruthy();
    expect(structure.indexPage).toContain('Event Bus Core');
  });
});

// ---------------------------------------------------------------------------
// formatWikiOutput
// ---------------------------------------------------------------------------

describe('formatWikiOutput', () => {
  it('includes file markers for each page', () => {
    const structure = buildWikiStructure([communityA, communityB]);
    const output = formatWikiOutput(structure);
    expect(output).toContain('--- FILE: docs/wiki/index.md ---');
    expect(output).toContain('--- FILE: docs/wiki/event-bus-core.md ---');
    expect(output).toContain('--- FILE: docs/wiki/agent-framework.md ---');
  });
});
