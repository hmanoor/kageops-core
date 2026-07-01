// B-180: VS Code Extension, B-181: JetBrains Plugin, B-182: Jira/Linear Sync,
// B-183: Slack Notifications, B-184: MCP Extension Marketplace

// ── Types ──────────────────────────────────────────────────────────────────

export interface IdeExtensionConfig {
  readonly ide: 'vscode' | 'jetbrains';
  readonly extensionId: string;
  readonly version: string;
  readonly apiEndpoint: string;
  readonly enabled: boolean;
  readonly features: readonly string[];
}

export interface IdeCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly keybinding: string | null;
}

export interface JiraSyncConfig {
  readonly provider: 'jira' | 'linear';
  readonly apiUrl: string;
  readonly projectKey: string;
  readonly syncInterval: number;
  readonly bidirectional: boolean;
  readonly statusMapping: Readonly<Record<string, string>>;
}

export interface SyncedIssue {
  readonly externalId: string;
  readonly internalTaskId: string;
  readonly title: string;
  readonly status: string;
  readonly lastSynced: string;
  readonly direction: 'inbound' | 'outbound' | 'bidirectional';
}

export interface SlackNotificationConfig {
  readonly webhookUrl: string;
  readonly channel: string;
  readonly events: readonly string[];
  readonly mentionUsers: readonly string[];
  readonly enabled: boolean;
}

export interface SlackBlock {
  readonly type: 'section' | 'header' | 'divider' | 'context' | 'actions';
  readonly text?: { readonly type: string; readonly text: string };
  readonly fields?: readonly { readonly type: string; readonly text: string }[];
}

export interface SlackMessage {
  readonly channel: string;
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
  readonly unfurlLinks: boolean;
}

export interface McpServer {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  readonly tools: readonly string[];
  readonly category: string;
  readonly downloads: number;
  readonly verified: boolean;
}

export interface McpMarketplace {
  readonly servers: readonly McpServer[];
  readonly categories: readonly string[];
  readonly totalCount: number;
  readonly lastUpdated: string;
}

export interface McpInstallResult {
  readonly serverId: string;
  readonly success: boolean;
  readonly installedVersion: string | null;
  readonly error: string | null;
}

// ── IDE Commands (B-180, B-181) ────────────────────────────────────────────

const IDE_COMMAND_DEFS: readonly { id: string; title: string; keybinding: string | null }[] = [
  { id: 'startProject', title: 'Start Project', keybinding: 'ctrl+shift+k' },
  { id: 'showAgents', title: 'Show Agents', keybinding: 'ctrl+shift+a' },
  { id: 'approveTask', title: 'Approve Task', keybinding: 'ctrl+shift+t' },
  { id: 'viewTraces', title: 'View Traces', keybinding: 'ctrl+shift+v' },
  { id: 'openPlayground', title: 'Open Playground', keybinding: 'ctrl+shift+p' },
  { id: 'syncStatus', title: 'Sync Status', keybinding: null },
  { id: 'showDashboard', title: 'Show Dashboard', keybinding: null },
  { id: 'configureSettings', title: 'Configure Settings', keybinding: null },
] as const;

export const VSCODE_COMMANDS: readonly IdeCommand[] = IDE_COMMAND_DEFS.map(c => ({
  id: `kageops.${c.id}`,
  title: c.title,
  category: 'KageOps',
  keybinding: c.keybinding,
}));

export const JETBRAINS_COMMANDS: readonly IdeCommand[] = IDE_COMMAND_DEFS.map(c => ({
  id: `com.kageops.${c.id}`,
  title: c.title,
  category: 'KageOps',
  keybinding: c.keybinding,
}));

// ── IDE Config (B-180, B-181) ──────────────────────────────────────────────

const IDE_DEFAULTS: Record<'vscode' | 'jetbrains', Omit<IdeExtensionConfig, 'ide'>> = {
  vscode: {
    extensionId: 'kageops.kageops-vscode',
    version: '0.1.0',
    apiEndpoint: 'http://localhost:3100',
    enabled: true,
    features: ['commands', 'statusBar', 'webview', 'treeView'],
  },
  jetbrains: {
    extensionId: 'com.kageops.jetbrains',
    version: '0.1.0',
    apiEndpoint: 'http://localhost:3100',
    enabled: true,
    features: ['toolWindow', 'actions', 'statusWidget', 'notifications'],
  },
};

export function createIdeConfig(
  ide: 'vscode' | 'jetbrains',
  overrides?: Partial<IdeExtensionConfig>,
): IdeExtensionConfig {
  const defaults = IDE_DEFAULTS[ide];
  return { ide, ...defaults, ...overrides };
}

// ── Jira/Linear Sync (B-182) ──────────────────────────────────────────────

const DEFAULT_STATUS_MAPPING: Readonly<Record<string, string>> = {
  pending: 'To Do',
  in_progress: 'In Progress',
  review: 'In Review',
  completed: 'Done',
  blocked: 'Blocked',
};

export function createJiraSyncConfig(
  provider: 'jira' | 'linear',
  apiUrl: string,
  projectKey: string,
): JiraSyncConfig {
  return {
    provider,
    apiUrl,
    projectKey,
    syncInterval: 300,
    bidirectional: true,
    statusMapping: { ...DEFAULT_STATUS_MAPPING },
  };
}

export function mapTaskStatus(
  internalStatus: string,
  mapping: Readonly<Record<string, string>>,
): string {
  return mapping[internalStatus] ?? internalStatus;
}

export function syncIssue(issue: SyncedIssue, newStatus: string): SyncedIssue {
  return { ...issue, status: newStatus, lastSynced: new Date().toISOString() };
}

// ── Slack Notifications (B-183) ────────────────────────────────────────────

export function buildSlackMessage(
  event: string,
  detail: string,
  config: SlackNotificationConfig,
): SlackMessage {
  const mentions = config.mentionUsers.map(u => `<@${u}>`).join(' ');
  return {
    channel: config.channel,
    text: `[${event}] ${detail}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: event } },
      { type: 'section', text: { type: 'mrkdwn', text: detail } },
      ...(mentions ? [{ type: 'context' as const, text: { type: 'mrkdwn', text: mentions } }] : []),
    ],
    unfurlLinks: false,
  };
}

export function formatSlackNotification(
  taskTitle: string,
  agentName: string,
  status: string,
): SlackMessage {
  return {
    channel: '#kageops',
    text: `${agentName} — ${taskTitle}: ${status}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Task Update: ${taskTitle}` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Agent:*\n${agentName}` },
          { type: 'mrkdwn', text: `*Status:*\n${status}` },
        ],
      },
      { type: 'divider' },
    ],
    unfurlLinks: false,
  };
}

// ── MCP Marketplace (B-184) ────────────────────────────────────────────────

export const SAMPLE_MCP_SERVERS: readonly McpServer[] = [
  { id: 'mcp-fs', name: 'File System', description: 'Read/write local files', version: '1.0.0', author: 'kageops', tools: ['read_file', 'write_file', 'list_dir'], category: 'filesystem', downloads: 12000, verified: true },
  { id: 'mcp-git', name: 'Git', description: 'Git operations and history', version: '1.2.0', author: 'kageops', tools: ['git_log', 'git_diff', 'git_commit'], category: 'vcs', downloads: 9500, verified: true },
  { id: 'mcp-db', name: 'Database', description: 'SQL query execution', version: '0.9.0', author: 'community', tools: ['query', 'schema', 'migrate'], category: 'database', downloads: 7200, verified: false },
  { id: 'mcp-web', name: 'Web Search', description: 'Search the web', version: '1.1.0', author: 'kageops', tools: ['search', 'fetch_page'], category: 'web', downloads: 11000, verified: true },
  { id: 'mcp-code', name: 'Code Analysis', description: 'Static analysis and linting', version: '0.8.0', author: 'community', tools: ['lint', 'analyze', 'complexity'], category: 'analysis', downloads: 4300, verified: false },
  { id: 'mcp-deploy', name: 'Deployment', description: 'Deploy to cloud providers', version: '1.0.0', author: 'kageops', tools: ['deploy', 'rollback', 'status'], category: 'deployment', downloads: 6100, verified: true },
];

export function searchMcpServers(
  marketplace: McpMarketplace,
  query: string,
): readonly McpServer[] {
  const q = query.toLowerCase();
  return marketplace.servers.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.tools.some(t => t.toLowerCase().includes(q)),
  );
}

export function filterByCategory(
  marketplace: McpMarketplace,
  category: string,
): readonly McpServer[] {
  return marketplace.servers.filter(s => s.category === category);
}

export function installMcpServer(server: McpServer): McpInstallResult {
  return {
    serverId: server.id,
    success: true,
    installedVersion: server.version,
    error: null,
  };
}

export function formatMcpServerCard(server: McpServer): string {
  const badge = server.verified ? ' [verified]' : '';
  return [
    `## ${server.name}${badge}`,
    `*${server.description}*`,
    `- **Version:** ${server.version}`,
    `- **Author:** ${server.author}`,
    `- **Tools:** ${server.tools.join(', ')}`,
    `- **Downloads:** ${server.downloads.toLocaleString()}`,
  ].join('\n');
}

// ── Integration Dashboard ──────────────────────────────────────────────────

export function formatIntegrationDashboard(
  ideConfigs: readonly IdeExtensionConfig[],
  jiraConfig: JiraSyncConfig | null,
  slackConfig: SlackNotificationConfig | null,
  mcpCount: number,
): string {
  const lines: string[] = ['# Integration Dashboard', ''];
  lines.push('## IDE Extensions');
  for (const c of ideConfigs) {
    lines.push(`- **${c.ide}** (${c.extensionId}) — ${c.enabled ? 'enabled' : 'disabled'}`);
  }
  lines.push('');
  lines.push('## Issue Tracker');
  lines.push(jiraConfig ? `- **${jiraConfig.provider}** — ${jiraConfig.projectKey} (${jiraConfig.syncInterval}s)` : '- Not configured');
  lines.push('');
  lines.push('## Slack');
  lines.push(slackConfig ? `- **${slackConfig.channel}** — ${slackConfig.enabled ? 'enabled' : 'disabled'} (${slackConfig.events.length} events)` : '- Not configured');
  lines.push('');
  lines.push(`## MCP Marketplace`);
  lines.push(`- ${mcpCount} servers available`);
  return lines.join('\n');
}
