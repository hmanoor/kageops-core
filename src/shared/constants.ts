import { DeploymentTarget, Settings } from './types';

export const PROVIDER_LABELS = {
  claude: 'Claude',
  codex: 'OpenAI Codex',
  copilot: 'GitHub Copilot',
  gemini: 'Google Gemini',
  opencode: 'OpenCode',
  ollama: 'Ollama (Local)',
} as const;

export const PROVIDER_BINARIES = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  gemini: 'gemini',
  opencode: 'opencode',
  ollama: 'ollama',
} as const;

export const THINKING_PHRASES = [
  // Cognitive (witty)
  'Thinking out loud...',
  'Reading the room...',
  'Connecting the dots...',
  'Following the thought...',
  'Squinting at the screen...',
  'Asking the rubber duck...',
  'Pair-programming with myself...',
  'Talking to the cache...',
  'Consulting the oracle...',
  'Negotiating with chaos...',

  // Engineering
  'Reticulating splines...',
  'Convincing the compiler...',
  'Bribing the linter...',
  'Outsmarting the bug...',
  'Out-foxing the race condition...',
  'Petitioning the kernel...',
  'Coaxing the daemon...',
  'Greasing the gears...',
  'Spinning up the cogs...',
  'Tuning the mainframe...',
  'Calibrating the compass...',
  'Polishing the algorithm...',
  'Pruning the decision tree...',
  'Wrangling the bytes...',
  'Bootstrapping in style...',

  // Brainwork
  'Triangulating the answer...',
  'Crunching the numbers...',
  'Threading the needle...',
  'Folding the protein...',
  'Mapping the territory...',
  'Cross-referencing the codex...',
  'Decoding the runes...',
  'Solving the sudoku...',
  'Catching the next thought...',
  'Untangling the wires...',
  'Hunting the hidden bug...',

  // Whimsical
  'Rolling for initiative...',
  'Asking the elders...',
  'Channeling Knuth...',
  'Counting to ten (in binary)...',
  'Drawing the short straw...',
  'Doing the dishes (mentally)...',
  'Lighting the candles...',
  'Sweeping the leg...',
  'Cracking knuckles...',
  'Stretching first...',
  'Limbering up the neurons...',
  'Sharpening the pencil...',
  'Booting the second brain...',
  'Recharging the muse...',
  'Buffering inspiration...',

  // Cooking metaphors
  'Brewing fresh ideas...',
  'Letting it simmer...',
  'Stirring the soup...',
  'Whisking it together...',
  'Folding in the answer...',
  'Caramelizing the logic...',

  // Creative
  'Sketching the napkin...',
  'Doodling the architecture...',
  'Whiteboarding silently...',
  'Sprouting an idea...',
  'Stitching the prototype...',
  'Polishing the pearl...',

  // Calm / focus
  'Aligning the priorities...',
  'Quietly contemplating...',
  'Mapping the unknown...',
  'Listening for the whisper...',
  'Holding the thought...',
  'Tuning into the signal...',
] as const;

export const COMPLETION_PHRASES = [
  'Done!',
  'Here you go!',
  'All set!',
  'Ta-da!',
  'Finished!',
  'Ready!',
] as const;

// Ship empty — the previous KageOps platform entry was the operator's own
// Azure subscription leaking into every install. Users add their own targets
// via the Deployments panel; nothing pre-populates.
const DEFAULT_DEPLOYMENTS: readonly DeploymentTarget[] = [];

// Default chat model — Ollama cloud model, no local GPU needed
export const DEFAULT_CHAT_MODEL = 'gpt-oss:120b-cloud';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'midnight',
  deployments: DEFAULT_DEPLOYMENTS,
  hasSeenWelcome: false,
  planSelected: false,
  autoUpdateEnabled: true, // Default ON — opt-out, not opt-in (decision #76)
  lastUpdateCheckAt: null,
  // F-395: null = follow embedded app-update.yml channel; UI exposes an
  // override picker for operators who want to flip a beta install to
  // latest (or vice versa) without re-downloading.
  releaseChannel: null,
};

// WINDOW_FALLBACK_PATHS moved to shell-environment.ts (main process only)
