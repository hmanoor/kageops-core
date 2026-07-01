import { describe, it, expect } from 'vitest';
import {
  createSession,
  addMessage,
  createMessage,
  concludeSession,
  filterByType,
  getThread,
  buildSessionSummary,
  serializeMessage,
  deserializeMessage,
  DEFAULT_CONFIG,
  type BrainstormMessage,
  type BrainstormServerConfig,
} from '../../src/agents/brainstorm-server';

describe('brainstorm-server', () => {
  const PARTICIPANTS = ['Pixel', 'user'] as const;
  const TOPIC = 'Dark mode redesign';

  describe('createSession', () => {
    it('creates active session with correct fields', () => {
      const session = createSession('s1', TOPIC, PARTICIPANTS);
      expect(session.id).toBe('s1');
      expect(session.topic).toBe(TOPIC);
      expect(session.participants).toEqual(PARTICIPANTS);
      expect(session.messages).toHaveLength(0);
      expect(session.status).toBe('active');
      expect(typeof session.createdAt).toBe('number');
    });
  });

  describe('addMessage', () => {
    it('appends message immutably', () => {
      const session = createSession('s1', TOPIC, PARTICIPANTS);
      const msg = createMessage('idea', 'Pixel', 'Use frosted glass');
      const updated = addMessage(session, msg);
      expect(updated.messages).toHaveLength(1);
      expect(session.messages).toHaveLength(0); // original unchanged
      expect(updated.messages[0]).toBe(msg);
    });

    it('enforces max messages limit by dropping oldest', () => {
      const config: BrainstormServerConfig = {
        port: 9876,
        maxSessions: 10,
        maxMessagesPerSession: 3,
      };
      let session = createSession('s1', TOPIC, PARTICIPANTS);
      const msgs: BrainstormMessage[] = [];
      for (let i = 0; i < 4; i++) {
        const m = createMessage('idea', 'Pixel', `Idea ${i}`);
        msgs.push(m);
        session = addMessage(session, m, config);
      }
      expect(session.messages).toHaveLength(3);
      // oldest (Idea 0) dropped, newest 3 retained
      expect(session.messages[0].content).toBe('Idea 1');
      expect(session.messages[2].content).toBe('Idea 3');
    });
  });

  describe('createMessage', () => {
    it('sets timestamp and type', () => {
      const before = Date.now();
      const msg = createMessage('feedback', 'user', 'Looks good');
      const after = Date.now();
      expect(msg.type).toBe('feedback');
      expect(msg.author).toBe('user');
      expect(msg.content).toBe('Looks good');
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });

    it('defaults parentId to null', () => {
      const msg = createMessage('idea', 'Pixel', 'Bold typography');
      expect(msg.parentId).toBeNull();
    });

    it('accepts explicit parentId', () => {
      const msg = createMessage('refine', 'user', 'Add shadow', 'parent-123');
      expect(msg.parentId).toBe('parent-123');
    });
  });

  describe('concludeSession', () => {
    it('sets status to concluded', () => {
      const session = createSession('s1', TOPIC, PARTICIPANTS);
      expect(session.status).toBe('active');
      const concluded = concludeSession(session);
      expect(concluded.status).toBe('concluded');
      expect(session.status).toBe('active'); // original unchanged
    });
  });

  describe('filterByType', () => {
    it('returns only matching messages', () => {
      let session = createSession('s1', TOPIC, PARTICIPANTS);
      session = addMessage(session, createMessage('idea', 'Pixel', 'Idea A'));
      session = addMessage(session, createMessage('feedback', 'user', 'Nice'));
      session = addMessage(session, createMessage('idea', 'Pixel', 'Idea B'));
      const ideas = filterByType(session, 'idea');
      expect(ideas).toHaveLength(2);
      expect(ideas.every((m) => m.type === 'idea')).toBe(true);
    });

    it('returns empty array for no matches', () => {
      const session = createSession('s1', TOPIC, PARTICIPANTS);
      expect(filterByType(session, 'vote')).toHaveLength(0);
    });
  });

  describe('getThread', () => {
    it('returns messages with matching parentId', () => {
      let session = createSession('s1', TOPIC, PARTICIPANTS);
      const parent = createMessage('idea', 'Pixel', 'Root idea');
      session = addMessage(session, parent);
      const child1 = createMessage('refine', 'user', 'Refine it', 'root-id');
      const child2 = createMessage('feedback', 'Pixel', 'Good catch', 'root-id');
      session = addMessage(session, child1);
      session = addMessage(session, child2);
      const thread = getThread(session, 'root-id');
      expect(thread).toHaveLength(2);
    });

    it('returns empty for unknown parentId', () => {
      const session = createSession('s1', TOPIC, PARTICIPANTS);
      expect(getThread(session, 'nonexistent')).toHaveLength(0);
    });
  });

  describe('buildSessionSummary', () => {
    it('includes topic and counts', () => {
      let session = createSession('s1', TOPIC, PARTICIPANTS);
      session = addMessage(session, createMessage('idea', 'Pixel', 'Frosted glass'));
      session = addMessage(session, createMessage('feedback', 'user', 'Love it'));
      const summary = buildSessionSummary(session);
      expect(summary).toContain(TOPIC);
      expect(summary).toContain('Ideas: 1');
      expect(summary).toContain('Feedback: 1');
      expect(summary).toContain('Frosted glass');
    });
  });

  describe('serializeMessage', () => {
    it('produces valid JSON', () => {
      const msg = createMessage('idea', 'Pixel', 'Bold move');
      const json = serializeMessage(msg);
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed.type).toBe('idea');
      expect(parsed.author).toBe('Pixel');
    });
  });

  describe('deserializeMessage', () => {
    it('parses valid JSON', () => {
      const msg = createMessage('vote', 'user', 'Yes!');
      const json = serializeMessage(msg);
      const result = deserializeMessage(json);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('vote');
      expect(result?.author).toBe('user');
      expect(result?.parentId).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(deserializeMessage('not-json{')).toBeNull();
    });

    it('returns null for missing fields', () => {
      const partial = JSON.stringify({ type: 'idea', author: 'Pixel' });
      expect(deserializeMessage(partial)).toBeNull();
    });

    it('returns null for invalid type field', () => {
      const bad = JSON.stringify({
        type: 'unknown',
        author: 'Pixel',
        content: 'Hi',
        timestamp: Date.now(),
        parentId: null,
      });
      expect(deserializeMessage(bad)).toBeNull();
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('has expected values', () => {
      expect(DEFAULT_CONFIG.port).toBe(9876);
      expect(DEFAULT_CONFIG.maxSessions).toBe(10);
      expect(DEFAULT_CONFIG.maxMessagesPerSession).toBe(200);
    });
  });
});
