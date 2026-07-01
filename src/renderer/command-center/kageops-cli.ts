/**
 * KageOps CLI — REPL command handler for the Terminal panel (B-510)
 *
 * Lines starting with `/` are intercepted by the shell panel and routed
 * here before reaching the underlying shell process. Non-`/` lines are
 * not handled here and fall through to the shell.
 *
 * CLI_COMMAND_DEFS is exported for the command palette autocomplete.
 */

// ── Command palette definitions ───────────────────────────────────────────

export interface CliCommandDef {
    /** Text shown in the palette label column, including any arg hints. */
    readonly label: string;
    /** Text inserted into the input on selection. Trailing space = needs args. */
    readonly template: string;
    readonly description: string;
}

export const CLI_COMMAND_DEFS: readonly CliCommandDef[] = [
    { label: '/help',                        template: '/help',         description: 'Show available commands' },
    { label: '/status',                      template: '/status',       description: 'System status (DB, orchestrator, agents)' },
    { label: '/agents',                      template: '/agents',       description: 'List all agents and current status' },
    { label: '/projects',                    template: '/projects',     description: 'List active projects' },
    { label: '/projects all',                template: '/projects all', description: 'Include completed and archived projects' },
    { label: '/approvals',                   template: '/approvals',    description: 'Show pending approval queue' },
    { label: '/sensei <message>',            template: '/sensei ',      description: 'Message Sensei orchestrator' },
    { label: '/approve <projectId>',         template: '/approve ',     description: 'Approve a pending gate' },
    { label: '/deny <projectId>',            template: '/deny ',        description: 'Deny a pending gate' },
    { label: '/pause <agent> <taskId>',      template: '/pause ',       description: 'Pause an agent mid-task' },
    { label: '/resume <agent> <taskId>',     template: '/resume ',      description: 'Resume a paused agent' },
    { label: '/inject <agent> <taskId> <msg>', template: '/inject ',    description: 'Inject guidance into a running task' },
    { label: '/takeover <agent> <taskId>',   template: '/takeover ',    description: 'Take over a task (hand to human)' },
    { label: '/retry-failed <projectId>',    template: '/retry-failed ', description: 'Retry all failed tasks in a project' },
    { label: '/retry-task <taskId>',         template: '/retry-task ',   description: 'Retry a single failed task by ID' },
    { label: '/retry-phase <projectId> <phase>', template: '/retry-phase ', description: 'Retry all failed tasks in a phase' },
    { label: '/reopen-project <projectId>',  template: '/reopen-project ', description: 'Reopen a completed/cancelled/archived project so Sensei can dispatch new work' },
    { label: '/close-project <projectId>',   template: '/close-project ',  description: 'Mark an active project completed (triggers build-summary report)' },
    { label: '/models',                       template: '/models',          description: 'Show every agent\'s active model + provider (truth source — bypasses Sensei)' },
    { label: '/models <agent>',               template: '/models ',         description: 'Show one agent\'s model + fallback chain' },
    { label: '/models <agent> <model>',       template: '/models ',         description: 'Override one agent\'s model (e.g. /models forge codex-cli/gpt-5-codex)' },
];

const KNOWN_AGENT_NAMES_CLI = [
    'sensei', 'scout', 'blueprint', 'pixel', 'forge', 'cipher', 'aegis', 'vigil', 'herald',
] as const;

declare const kageOps: {
    getSystemStatus(): Promise<unknown>;
    getAgents(): Promise<unknown[]>;
    listProjectsFiltered(filter?: {
        include?: readonly string[];
        exclude?: readonly string[];
        includeArchived?: boolean;
    }): Promise<unknown[]>;
    sendToSensei(message: string): Promise<string>;
    approveGate(projectId: string): Promise<void>;
    denyGate(projectId: string): Promise<void>;
    pauseAgent(agentName: string, taskId: string): Promise<unknown>;
    resumeAgent(agentName: string, taskId: string): Promise<unknown>;
    injectGuidance(agentName: string, taskId: string, guidance: string): Promise<unknown>;
    takeoverTask(agentName: string, taskId: string): Promise<unknown>;
    getApprovalQueue(): Promise<unknown[]>;
    retryFailedTasks(projectId: string): Promise<unknown>;
    retryTask(taskId: string): Promise<{ retried: number; projectId: string | null }>;
    retryPhase(projectId: string, phase: string): Promise<{ retried: number }>;
    reopenProject(projectId: string): Promise<{ success: boolean; status?: string; fromStatus?: string; changed?: boolean; error?: string }>;
    closeProject(projectId: string): Promise<{ success: boolean; status?: string; fromStatus?: string; changed?: boolean; error?: string }>;
    getConfigSnapshot(): Promise<{
        agents?: Record<string, { model?: string; provider?: string; fallbackModels?: readonly string[] }>;
        providers?: Record<string, unknown>;
    }>;
    setAgentProvider(agentName: string, provider: string, model: string): Promise<{ success: boolean; error?: string }>;
};

const HELP_LINES = [
    'KageOps CLI — available commands',
    '',
    '  /help                              Show this help',
    '  /status                            System status (DB, orchestrator, agents)',
    '  /agents                            List all agents and current status',
    '  /projects                          List active projects',
    '  /projects all                      Include completed and archived projects',
    '  /approvals                         Show pending approval queue',
    '  /sensei <message>                  Send a message to Sensei orchestrator',
    '  /approve <projectId>               Approve a pending gate',
    '  /deny <projectId> [reason]         Deny a pending gate',
    '  /pause <agent> <taskId>            Pause an agent mid-task',
    '  /resume <agent> <taskId>           Resume a paused agent',
    '  /inject <agent> <taskId> <msg>     Inject guidance into a running task',
    '  /takeover <agent> <taskId>         Take over a task (hand to human)',
    '  /retry-failed <projectId>          Retry all failed tasks in a project',
    '  /retry-task <taskId>               Retry a single failed task by ID',
    '  /retry-phase <projectId> <phase>   Retry all failed tasks in a phase',
    '  /reopen-project <projectId>        Reopen a completed/cancelled/archived project',
    '  /close-project <projectId>         Mark an active project completed (generates build report)',
    '  /models                            Truth source: every agent\'s active model + provider',
    '  /models <agent>                    Show one agent\'s model + fallback chain',
    '  /models <agent> <model>            Override one agent\'s model live',
    '',
    '  Regular shell commands (no leading /) run in the shell as normal.',
];

type AppendFn = (text: string, cls: string) => void;
type SysFn = (msg: string) => void;

/**
 * Handle a `/command` line from the shell panel REPL.
 * Returns true if the line was consumed, false if it should fall through.
 */
export async function handleCliCommand(
    line: string,
    append: AppendFn,
    sys: SysFn,
): Promise<boolean> {
    const trimmed = line.trim();
    if (!trimmed.startsWith('/')) return false;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0] ?? '';
    const args = parts.slice(1);

    switch (cmd) {
        case '/help': {
            for (const l of HELP_LINES) {
                append(l, 'ishell-line--system');
            }
            return true;
        }

        case '/status': {
            sys('[KageOps] Fetching system status…');
            try {
                const status = await kageOps.getSystemStatus();
                formatObject(status, append);
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/agents': {
            sys('[KageOps] Fetching agents…');
            try {
                const agents = await kageOps.getAgents();
                if (!Array.isArray(agents) || agents.length === 0) {
                    append('No agents registered.', 'ishell-line--system');
                    return true;
                }
                for (const a of agents) {
                    const rec = a as Record<string, unknown>;
                    const name = String(rec['name'] ?? rec['agentName'] ?? '?');
                    const status = String(rec['status'] ?? rec['state'] ?? 'unknown');
                    const task = typeof rec['currentTaskId'] === 'string'
                        ? ` · task: ${rec['currentTaskId'].slice(0, 8)}`
                        : '';
                    append(`  ${name.padEnd(14)} ${status}${task}`, 'ishell-line--stdout');
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/projects': {
            const includeAll = args[0] === 'all';
            sys(`[KageOps] Fetching projects${includeAll ? ' (all)' : ' (active)'}…`);
            try {
                const filter = includeAll
                    ? { includeArchived: true }
                    : { exclude: ['completed', 'archived', 'cancelled'] };
                const projects = await kageOps.listProjectsFiltered(filter);
                if (!Array.isArray(projects) || projects.length === 0) {
                    append('No projects found.', 'ishell-line--system');
                    return true;
                }
                append('  ID        Name                      Phase                 Status', 'ishell-line--system');
                for (const p of projects) {
                    const rec = p as Record<string, unknown>;
                    const id = String(rec['id'] ?? '').slice(0, 8);
                    const name = String(rec['name'] ?? '?').slice(0, 24).padEnd(24);
                    const phase = String(rec['current_phase'] ?? rec['currentPhase'] ?? '?').padEnd(20);
                    const status = String(rec['status'] ?? '?');
                    append(`  ${id}  ${name}  ${phase}  ${status}`, 'ishell-line--stdout');
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/approvals': {
            sys('[KageOps] Fetching approval queue…');
            try {
                const queue = await kageOps.getApprovalQueue();
                if (!Array.isArray(queue) || queue.length === 0) {
                    append('No pending approvals.', 'ishell-line--system');
                    return true;
                }
                append('  ID        Name                      Phase', 'ishell-line--system');
                for (const a of queue) {
                    const rec = a as Record<string, unknown>;
                    const id = String(rec['id'] ?? '').slice(0, 8);
                    const name = String(rec['name'] ?? '?').slice(0, 24).padEnd(24);
                    const phase = String(rec['phase'] ?? rec['current_phase'] ?? '?');
                    append(`  ${id}  ${name}  ${phase}`, 'ishell-line--stdout');
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/sensei': {
            if (args.length === 0) {
                append('Usage: /sensei <message>', 'ishell-line--stderr');
                return true;
            }
            const msg = args.join(' ');
            sys(`[Sensei] ${msg}`);
            try {
                const reply = await kageOps.sendToSensei(msg);
                if (typeof reply === 'string' && reply.trim() !== '') {
                    for (const l of reply.split('\n')) {
                        append(`  ${l}`, 'ishell-line--stdout');
                    }
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/approve': {
            const projectId = args[0];
            if (projectId === undefined || projectId === '') {
                append('Usage: /approve <projectId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Approving ${projectId}…`);
            try {
                await kageOps.approveGate(projectId);
                append(`✓ Approved: ${projectId}`, 'ishell-line--stdout');
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/deny': {
            const projectId = args[0];
            if (projectId === undefined || projectId === '') {
                append('Usage: /deny <projectId> [reason]', 'ishell-line--stderr');
                return true;
            }
            const reason = args.slice(1).join(' ');
            sys(`[KageOps] Denying ${projectId}…`);
            try {
                await kageOps.denyGate(projectId);
                append(
                    `✗ Denied: ${projectId}${reason !== '' ? ` — ${reason}` : ''}`,
                    'ishell-line--stdout',
                );
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/pause': {
            const [agentName, taskId] = args;
            if (agentName === undefined || taskId === undefined) {
                append('Usage: /pause <agent> <taskId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Pausing ${agentName} on task ${taskId.slice(0, 8)}…`);
            try {
                await kageOps.pauseAgent(agentName, taskId);
                append(`✓ Paused ${agentName}`, 'ishell-line--stdout');
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/resume': {
            const [agentName, taskId] = args;
            if (agentName === undefined || taskId === undefined) {
                append('Usage: /resume <agent> <taskId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Resuming ${agentName} on task ${taskId.slice(0, 8)}…`);
            try {
                await kageOps.resumeAgent(agentName, taskId);
                append(`✓ Resumed ${agentName}`, 'ishell-line--stdout');
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/inject': {
            const [agentName, taskId, ...guidanceParts] = args;
            if (agentName === undefined || taskId === undefined || guidanceParts.length === 0) {
                append('Usage: /inject <agent> <taskId> <message>', 'ishell-line--stderr');
                return true;
            }
            const guidance = guidanceParts.join(' ');
            sys(`[KageOps] Injecting guidance into ${agentName}…`);
            try {
                await kageOps.injectGuidance(agentName, taskId, guidance);
                append(`✓ Guidance injected into ${agentName}`, 'ishell-line--stdout');
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/takeover': {
            const [agentName, taskId] = args;
            if (agentName === undefined || taskId === undefined) {
                append('Usage: /takeover <agent> <taskId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Taking over task ${taskId.slice(0, 8)} from ${agentName}…`);
            try {
                await kageOps.takeoverTask(agentName, taskId);
                append(`✓ Task taken over from ${agentName}`, 'ishell-line--stdout');
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/retry-failed': {
            const projectId = args[0];
            if (projectId === undefined || projectId === '') {
                append('Usage: /retry-failed <projectId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Retrying failed tasks in ${projectId}…`);
            try {
                const result = await kageOps.retryFailedTasks(projectId) as { retried?: number };
                const n = result?.retried ?? 0;
                append(
                    n === 0 ? 'No failed tasks found.' : `✓ Re-queued ${n} task${n === 1 ? '' : 's'}`,
                    'ishell-line--stdout',
                );
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/retry-task': {
            const taskId = args[0];
            if (taskId === undefined || taskId === '') {
                append('Usage: /retry-task <taskId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Retrying task ${taskId.slice(0, 8)}…`);
            try {
                const result = await kageOps.retryTask(taskId);
                if (result.retried === 0) {
                    append('Task not found or not in a failed state.', 'ishell-line--system');
                } else {
                    append(`✓ Task re-queued${result.projectId ? ` (project ${result.projectId.slice(0, 8)})` : ''}`, 'ishell-line--stdout');
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/retry-phase': {
            const [projectId, phase] = args;
            if (projectId === undefined || phase === undefined) {
                append('Usage: /retry-phase <projectId> <phase>', 'ishell-line--stderr');
                append('Phases: discovery · poc · business-viability · design-planning · development · launch-growth', 'ishell-line--system');
                return true;
            }
            sys(`[KageOps] Retrying failed tasks in phase "${phase}" for ${projectId.slice(0, 8)}…`);
            try {
                const result = await kageOps.retryPhase(projectId, phase);
                const n = result.retried;
                append(
                    n === 0 ? `No failed tasks found in phase "${phase}".` : `✓ Re-queued ${n} task${n === 1 ? '' : 's'} in "${phase}"`,
                    'ishell-line--stdout',
                );
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/reopen-project': {
            const [projectId] = args;
            if (projectId === undefined) {
                append('Usage: /reopen-project <projectId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Reopening project ${projectId.slice(0, 8)}…`);
            try {
                const result = await kageOps.reopenProject(projectId);
                if (result.success === false) {
                    append(`Error: ${result.error ?? 'reopen failed'}`, 'ishell-line--stderr');
                } else if (result.changed === true) {
                    append(`✓ Project reopened (${result.fromStatus ?? '?'} → ${result.status ?? 'active'}). Sensei can now dispatch work.`, 'ishell-line--stdout');
                } else {
                    append(`No change — project was already in status "${result.status ?? 'unknown'}".`, 'ishell-line--system');
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        case '/close-project': {
            const [projectId] = args;
            if (projectId === undefined) {
                append('Usage: /close-project <projectId>', 'ishell-line--stderr');
                return true;
            }
            sys(`[KageOps] Closing project ${projectId.slice(0, 8)}…`);
            try {
                const result = await kageOps.closeProject(projectId);
                if (result.success === false) {
                    append(`Error: ${result.error ?? 'close failed'}`, 'ishell-line--stderr');
                } else if (result.changed === true) {
                    append(`✓ Project closed (${result.fromStatus ?? '?'} → completed). Build-summary report will be generated.`, 'ishell-line--stdout');
                } else {
                    append(`No change — project was already in status "${result.status ?? 'unknown'}".`, 'ishell-line--system');
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        // ── /models — truth source for "what's actually running"
        // /models                          list every agent's active model + provider
        // /models <agent>                  show one agent's full config (incl. fallbacks)
        // /models <agent> <model>          override one agent's model (rest-of-line so
        //                                   models with spaces / extra args still work)
        case '/models': {
            const [agentArg, ...modelParts] = args;
            const modelArg = modelParts.join(' ').trim();

            if (agentArg === undefined) {
                // List mode
                try {
                    const snap = await kageOps.getConfigSnapshot();
                    const agents = snap.agents ?? {};
                    const order = KNOWN_AGENT_NAMES_CLI;
                    sys(`[KageOps] Active model routing — read from src/main/main.ts config:get-snapshot:`);
                    for (const a of order) {
                        const entry = agents[a];
                        const model = entry?.model ?? '(unset)';
                        const provider = entry?.provider ?? 'unknown';
                        const fallbacks = entry?.fallbackModels ?? [];
                        const fallbackStr = fallbacks.length > 0 ? `  fallback=[${fallbacks.join(', ')}]` : '';
                        append(`  ${a.padEnd(10)} ${String(model).padEnd(40)} provider=${provider}${fallbackStr}`, 'ishell-line--stdout');
                    }
                    append('Hint: /models <agent> <model> to override one. Examples:', 'ishell-line--system');
                    append('  /models sensei codex-cli', 'ishell-line--system');
                    append('  /models forge openrouter/anthropic/claude-sonnet-4', 'ishell-line--system');
                    append('  /models pixel claude-cli/claude-opus-4-7', 'ishell-line--system');
                } catch (err) {
                    append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
                }
                return true;
            }

            const agent = agentArg.toLowerCase();
            if (!(KNOWN_AGENT_NAMES_CLI as readonly string[]).includes(agent)) {
                append(`Unknown agent: "${agent}". Valid: ${KNOWN_AGENT_NAMES_CLI.join(', ')}`, 'ishell-line--stderr');
                return true;
            }

            if (modelArg === '') {
                // Show one
                try {
                    const snap = await kageOps.getConfigSnapshot();
                    const entry = snap.agents?.[agent];
                    if (entry === undefined) {
                        append(`No config entry found for ${agent}. Run /models to list all.`, 'ishell-line--stderr');
                        return true;
                    }
                    append(`Agent:    ${agent}`, 'ishell-line--stdout');
                    append(`Model:    ${entry.model ?? '(unset)'}`, 'ishell-line--stdout');
                    append(`Provider: ${entry.provider ?? 'unknown'}`, 'ishell-line--stdout');
                    const fb = entry.fallbackModels ?? [];
                    append(`Fallbacks: ${fb.length === 0 ? '(none)' : fb.join(', ')}`, 'ishell-line--stdout');
                } catch (err) {
                    append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
                }
                return true;
            }

            // Set mode — derive provider from the model string's "provider/model" prefix
            // Same heuristic as model-parser: bare word with no slash → claude-cli;
            // anything with a slash → first segment is the provider.
            const slashIdx = modelArg.indexOf('/');
            const provider = slashIdx > 0
                ? modelArg.slice(0, slashIdx)
                : modelArg.includes('-cli')
                    ? modelArg          // e.g. "codex-cli", "claude-cli" — bare provider name
                    : 'claude';         // bare alias defaults to Claude API

            sys(`[KageOps] Setting ${agent} → model=${modelArg} provider=${provider}…`);
            try {
                const result = await kageOps.setAgentProvider(agent, provider, modelArg);
                if (result.success === true) {
                    append(`✓ ${agent} now using ${modelArg} (provider=${provider}). Takes effect on next agent task.`, 'ishell-line--stdout');
                } else {
                    append(`Error: ${result.error ?? 'setAgentProvider failed'}`, 'ishell-line--stderr');
                }
            } catch (err) {
                append(`Error: ${toMsg(err)}`, 'ishell-line--stderr');
            }
            return true;
        }

        default: {
            append(
                `Unknown command: ${cmd}  —  type /help for available commands.`,
                'ishell-line--stderr',
            );
            return true;
        }
    }
}

function toMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function formatObject(obj: unknown, append: AppendFn): void {
    if (typeof obj !== 'object' || obj === null) {
        append(String(obj), 'ishell-line--stdout');
        return;
    }
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const val = typeof value === 'object' && value !== null
            ? JSON.stringify(value)
            : String(value ?? '—');
        append(`  ${key.padEnd(24)} ${val}`, 'ishell-line--stdout');
    }
}
