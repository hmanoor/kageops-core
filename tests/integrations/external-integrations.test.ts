import { describe, it, expect } from 'vitest';
import {
  VSCODE_COMMANDS,
  JETBRAINS_COMMANDS,
  createIdeConfig,
  createJiraSyncConfig,
  mapTaskStatus,
  syncIssue,
  buildSlackMessage,
  formatSlackNotification,
  SAMPLE_MCP_SERVERS,
  searchMcpServers,
  filterByCategory,
  installMcpServer,
  formatMcpServerCard,
  formatIntegrationDashboard,
  type IdeCommand,
  type SyncedIssue,
  type SlackNotificationConfig,
  type McpMarketplace,
  type McpServer,
} from '../../src/integrations/external-integrations';

// ── IDE Commands (B-180, B-181) ────────────────────────────────────────────

describe('VSCODE_COMMANDS', () => {
  it('has 8 commands', () => {
    expect(VSCODE_COMMANDS).toHaveLength(8);
  });

  it.each(VSCODE_COMMANDS.map(c => [c.id, c]) as [string, IdeCommand][])(
    '%s has kageops prefix and KageOps category',
    (_id, cmd) => {
      expect(cmd.id).toMatch(/^kageops\./);
      expect(cmd.category).toBe('KageOps');
    },
  );
});

describe('JETBRAINS_COMMANDS', () => {
  it('has 8 commands', () => {
    expect(JETBRAINS_COMMANDS).toHaveLength(8);
  });

  it.each(JETBRAINS_COMMANDS.map(c => [c.id, c]) as [string, IdeCommand][])(
    '%s has com.kageops prefix',
    (_id, cmd) => {
      expect(cmd.id).toMatch(/^com\.kageops\./);
    },
  );
});

// ── createIdeConfig ────────────────────────────────────────────────────────

describe('createIdeConfig', () => {
  it.each(['vscode', 'jetbrains'] as const)('creates default %s config', (ide) => {
    const config = createIdeConfig(ide);
    expect(config.ide).toBe(ide);
    expect(config.enabled).toBe(true);
    expect(config.version).toBe('0.1.0');
    expect(config.features.length).toBeGreaterThan(0);
  });

  it('applies overrides without mutating defaults', () => {
    const config = createIdeConfig('vscode', { enabled: false, version: '2.0.0' });
    expect(config.enabled).toBe(false);
    expect(config.version).toBe('2.0.0');
    // defaults unchanged
    const fresh = createIdeConfig('vscode');
    expect(fresh.enabled).toBe(true);
  });
});

// ── Jira/Linear Sync (B-182) ──────────────────────────────────────────────

describe('createJiraSyncConfig', () => {
  it.each([
    ['jira', 'https://jira.example.com', 'KAG'],
    ['linear', 'https://api.linear.app', 'OPS'],
  ] as const)('creates %s config for project %s', (provider, apiUrl, projectKey) => {
    const config = createJiraSyncConfig(provider, apiUrl, projectKey);
    expect(config.provider).toBe(provider);
    expect(config.apiUrl).toBe(apiUrl);
    expect(config.projectKey).toBe(projectKey);
    expect(config.bidirectional).toBe(true);
    expect(config.syncInterval).toBe(300);
    expect(config.statusMapping['pending']).toBe('To Do');
  });
});

describe('mapTaskStatus', () => {
  const mapping = { pending: 'To Do', completed: 'Done' } as const;

  it.each([
    ['pending', 'To Do'],
    ['completed', 'Done'],
    ['unknown', 'unknown'],
  ])('maps "%s" to "%s"', (input, expected) => {
    expect(mapTaskStatus(input, mapping)).toBe(expected);
  });
});

describe('syncIssue', () => {
  it('returns new issue with updated status (immutable)', () => {
    const original: SyncedIssue = {
      externalId: 'JIRA-1',
      internalTaskId: 'task-1',
      title: 'Fix bug',
      status: 'pending',
      lastSynced: '2026-01-01T00:00:00Z',
      direction: 'bidirectional',
    };
    const updated = syncIssue(original, 'completed');
    expect(updated.status).toBe('completed');
    expect(updated.lastSynced).not.toBe(original.lastSynced);
    // original unchanged
    expect(original.status).toBe('pending');
  });
});

// ── Slack Notifications (B-183) ────────────────────────────────────────────

const slackConfig: SlackNotificationConfig = {
  webhookUrl: 'https://hooks.slack.com/test',
  channel: '#ops',
  events: ['task.completed'],
  mentionUsers: ['U123'],
  enabled: true,
};

describe('buildSlackMessage', () => {
  it('builds a blocks-based message', () => {
    const msg = buildSlackMessage('task.completed', 'Deploy finished', slackConfig);
    expect(msg.channel).toBe('#ops');
    expect(msg.text).toContain('task.completed');
    expect(msg.blocks.length).toBeGreaterThanOrEqual(2);
    expect(msg.blocks[0].type).toBe('header');
    expect(msg.unfurlLinks).toBe(false);
  });

  it('includes mention block when users configured', () => {
    const msg = buildSlackMessage('event', 'detail', slackConfig);
    const ctx = msg.blocks.find(b => b.type === 'context');
    expect(ctx?.text?.text).toContain('<@U123>');
  });

  it('omits mention block when no users', () => {
    const noMentions = { ...slackConfig, mentionUsers: [] as readonly string[] };
    const msg = buildSlackMessage('event', 'detail', noMentions);
    expect(msg.blocks.find(b => b.type === 'context')).toBeUndefined();
  });
});

describe('formatSlackNotification', () => {
  it('formats a task status notification', () => {
    const msg = formatSlackNotification('Build API', 'Forge', 'completed');
    expect(msg.channel).toBe('#kageops');
    expect(msg.text).toContain('Forge');
    expect(msg.blocks[0].type).toBe('header');
    expect(msg.blocks[1].fields).toBeDefined();
    expect(msg.blocks[2].type).toBe('divider');
  });
});

// ── MCP Marketplace (B-184) ────────────────────────────────────────────────

const marketplace: McpMarketplace = {
  servers: SAMPLE_MCP_SERVERS,
  categories: ['filesystem', 'vcs', 'database', 'web', 'analysis', 'deployment'],
  totalCount: SAMPLE_MCP_SERVERS.length,
  lastUpdated: '2026-04-01T00:00:00Z',
};

describe('SAMPLE_MCP_SERVERS', () => {
  it('has 6 servers', () => {
    expect(SAMPLE_MCP_SERVERS).toHaveLength(6);
  });
});

describe('searchMcpServers', () => {
  it.each([
    ['git', 1],
    ['file', 1],
    ['deploy', 1],
    ['query', 1],
    ['nonexistent', 0],
  ])('query "%s" returns %d results', (query, count) => {
    const results = searchMcpServers(marketplace, query);
    expect(results.length).toBe(count);
  });

  it('matches by tool name', () => {
    const results = searchMcpServers(marketplace, 'lint');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('mcp-code');
  });
});

describe('filterByCategory', () => {
  it('filters servers by category', () => {
    const results = filterByCategory(marketplace, 'vcs');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mcp-git');
  });

  it('returns empty for unknown category', () => {
    expect(filterByCategory(marketplace, 'unknown')).toHaveLength(0);
  });
});

describe('installMcpServer', () => {
  it('returns success result with version', () => {
    const server = SAMPLE_MCP_SERVERS[0];
    const result = installMcpServer(server);
    expect(result.serverId).toBe(server.id);
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBe(server.version);
    expect(result.error).toBeNull();
  });
});

describe('formatMcpServerCard', () => {
  it('includes name, description, and verified badge', () => {
    const card = formatMcpServerCard(SAMPLE_MCP_SERVERS[0]);
    expect(card).toContain('File System');
    expect(card).toContain('[verified]');
    expect(card).toContain('read_file');
  });

  it('omits verified badge for unverified servers', () => {
    const unverified = SAMPLE_MCP_SERVERS.find(s => !s.verified)!;
    const card = formatMcpServerCard(unverified);
    expect(card).not.toContain('[verified]');
  });
});

// ── Integration Dashboard ──────────────────────────────────────────────────

describe('formatIntegrationDashboard', () => {
  it('renders all sections', () => {
    const dash = formatIntegrationDashboard(
      [createIdeConfig('vscode'), createIdeConfig('jetbrains')],
      createJiraSyncConfig('jira', 'https://jira.example.com', 'KAG'),
      slackConfig,
      6,
    );
    expect(dash).toContain('# Integration Dashboard');
    expect(dash).toContain('vscode');
    expect(dash).toContain('jetbrains');
    expect(dash).toContain('jira');
    expect(dash).toContain('#ops');
    expect(dash).toContain('6 servers available');
  });

  it('shows not configured when null', () => {
    const dash = formatIntegrationDashboard([], null, null, 0);
    expect(dash).toContain('Not configured');
  });
});
