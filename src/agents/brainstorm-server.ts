/**
 * B-218: WebSocket brainstorming server data model for Pixel agent.
 * Provides immutable session and message management for real-time design sessions.
 * Does NOT start a WebSocket server — export only.
 */

export interface BrainstormMessage {
  readonly type: 'idea' | 'feedback' | 'vote' | 'refine' | 'system';
  readonly author: string;
  readonly content: string;
  readonly timestamp: number;
  readonly parentId: string | null;
}

export interface BrainstormSession {
  readonly id: string;
  readonly topic: string;
  readonly messages: readonly BrainstormMessage[];
  readonly participants: readonly string[];
  readonly createdAt: number;
  readonly status: 'active' | 'concluded';
}

export interface BrainstormServerConfig {
  readonly port: number;
  readonly maxSessions: number;
  readonly maxMessagesPerSession: number;
}

export const DEFAULT_CONFIG: BrainstormServerConfig = {
  port: 9876,
  maxSessions: 10,
  maxMessagesPerSession: 200,
};

export function createSession(
  id: string,
  topic: string,
  participants: readonly string[],
): BrainstormSession {
  return {
    id,
    topic,
    messages: [],
    participants,
    createdAt: Date.now(),
    status: 'active',
  };
}

export function addMessage(
  session: BrainstormSession,
  message: BrainstormMessage,
  config: BrainstormServerConfig = DEFAULT_CONFIG,
): BrainstormSession {
  const appended = [...session.messages, message];
  const trimmed =
    appended.length > config.maxMessagesPerSession
      ? appended.slice(appended.length - config.maxMessagesPerSession)
      : appended;
  return { ...session, messages: trimmed };
}

export function createMessage(
  type: BrainstormMessage['type'],
  author: string,
  content: string,
  parentId: string | null = null,
): BrainstormMessage {
  return {
    type,
    author,
    content,
    timestamp: Date.now(),
    parentId,
  };
}

export function concludeSession(session: BrainstormSession): BrainstormSession {
  return { ...session, status: 'concluded' };
}

export function filterByType(
  session: BrainstormSession,
  type: BrainstormMessage['type'],
): readonly BrainstormMessage[] {
  return session.messages.filter((m) => m.type === type);
}

export function getThread(
  session: BrainstormSession,
  parentId: string,
): readonly BrainstormMessage[] {
  return session.messages.filter((m) => m.parentId === parentId);
}

export function buildSessionSummary(session: BrainstormSession): string {
  const counts: Record<BrainstormMessage['type'], number> = {
    idea: 0,
    feedback: 0,
    vote: 0,
    refine: 0,
    system: 0,
  };
  for (const m of session.messages) {
    counts[m.type]++;
  }

  const ideas = session.messages
    .filter((m) => m.type === 'idea' && m.parentId === null)
    .map((m) => `- ${m.author}: ${m.content}`)
    .join('\n');

  const lines = [
    `# Brainstorm Session: ${session.topic}`,
    '',
    `**Participants:** ${session.participants.length}`,
    `**Total messages:** ${session.messages.length}`,
    '',
    '## Message breakdown',
    `- Ideas: ${counts.idea}`,
    `- Feedback: ${counts.feedback}`,
    `- Votes: ${counts.vote}`,
    `- Refinements: ${counts.refine}`,
    `- System: ${counts.system}`,
  ];

  if (ideas.length > 0) {
    lines.push('', '## Top-level ideas', ideas);
  }

  return lines.join('\n');
}

export function serializeMessage(message: BrainstormMessage): string {
  return JSON.stringify(message);
}

const REQUIRED_FIELDS: ReadonlyArray<keyof BrainstormMessage> = [
  'type',
  'author',
  'content',
  'timestamp',
  'parentId',
];

const VALID_TYPES = new Set<string>(['idea', 'feedback', 'vote', 'refine', 'system']);

export function deserializeMessage(data: string): BrainstormMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      return null;
    }
  }

  if (typeof obj['type'] !== 'string' || !VALID_TYPES.has(obj['type'])) {
    return null;
  }
  if (typeof obj['author'] !== 'string') {
    return null;
  }
  if (typeof obj['content'] !== 'string') {
    return null;
  }
  if (typeof obj['timestamp'] !== 'number') {
    return null;
  }
  if (obj['parentId'] !== null && typeof obj['parentId'] !== 'string') {
    return null;
  }

  return {
    type: obj['type'] as BrainstormMessage['type'],
    author: obj['author'],
    content: obj['content'],
    timestamp: obj['timestamp'],
    parentId: obj['parentId'] as string | null,
  };
}
