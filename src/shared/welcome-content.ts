export interface FeatureCard {
    readonly icon: string;
    readonly title: string;
    readonly description: string;
}

export interface HowToItem {
    readonly title: string;
    readonly description: string;
    readonly action: 'new-project' | 'open-settings' | 'docs';
}

export interface WhatsNew {
    readonly version: string;
    readonly date: string;
    readonly items: readonly string[];
}

export const FEATURE_CARDS: readonly FeatureCard[] = [
    {
        icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
        title: 'Multi-Agent Orchestration',
        description: 'Sensei coordinates 8 specialist agents — Scout, Blueprint, Forge, Pixel and more — working in parallel on your project.',
    },
    {
        icon: 'M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18',
        title: '6-Phase Lifecycle',
        description: 'Every project flows through Discovery → POC → Business Viability → Design → Development → Launch with automated phase gates.',
    },
    {
        icon: 'M13 10V3L4 14h7v7l9-11h-7z',
        title: 'Any AI Provider',
        description: 'Claude, GPT-4o, Gemini, Ollama — switch models per agent or per project. OpenRouter for budget runs, Claude CLI for premium.',
    },
    {
        icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
        title: 'Cost Guardrails',
        description: 'Per-run budget caps, per-task AI call limits, live cost tracking. Dry-run mode previews every project before spending a cent.',
    },
    {
        icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
        title: 'Real-Time Build Logs',
        description: 'Watch agents work live — task decomposition, code generation, test runs, acceptance gates — all streamed to the Command Center.',
    },
    {
        icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
        title: 'Auto Prompt Optimisation',
        description: 'APO nightly tunes agent prompts using beam search. Proposals surface for human review — you approve before anything changes.',
    },
] as const;

export const HOWTO_ITEMS: readonly HowToItem[] = [
    {
        title: 'Run your first project',
        description: 'Click "New Project" in the Command Center, describe your idea, and watch the agents build it end-to-end.',
        action: 'new-project',
    },
    {
        title: 'Configure your AI provider',
        description: 'Open Settings → Providers to set up Claude, OpenRouter, Ollama or any OpenAI-compatible endpoint.',
        action: 'open-settings',
    },
    {
        title: 'Invite your team',
        description: 'On a Team or Enterprise plan you can invite members, assign roles, and collaborate on projects together.',
        action: 'docs',
    },
] as const;

export const WHATS_NEW: WhatsNew = {
    version: '2.7',
    date: 'May 2026',
    items: [
        'Device-flow login — sign in via your browser, no passwords stored in the app',
        '"Use a different account" for seamless account switching',
        'Signed-in user pill in the Command Center top-bar',
        'Windows protocol handler fixed — kageops:// callback now reliable',
        'Sign-in window and browser tab close automatically after login',
    ],
} as const;
