import { AgentSession } from './agent-session';
import { ProviderType, AgentMessage } from '../shared/types';
import { createLogger } from '../shared/logger';

const log = createLogger('OllamaSession');

const OLLAMA_API_URL = 'http://localhost:11434/api/chat';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChunk {
  model: string;
  created_at: string;
  message?: { role: string; content: string };
  done: boolean;
  error?: string;
}

export class OllamaSession extends AgentSession {
  readonly provider: ProviderType = 'ollama';

  private _model: string = 'llama3.2';
  private _running = false;
  private _busy = false;
  private _abortController: AbortController | null = null;
  private _chatHistory: OllamaChatMessage[] = [];

  get isRunning(): boolean { return this._running; }
  get isBusy(): boolean { return this._busy; }

  setModel(model: string): void {
    this._model = model;
  }

  // Not used in HTTP mode — required by abstract base
  buildArgs(): string[] { return []; }

  // Not used in HTTP mode — required by abstract base
  parseLine(_line: string) { return null; }

  override start(): void {
    if (this._running) return;
    this._running = true;
    this._chatHistory = [];

    if (this._systemPrompt) {
      this._chatHistory = [{ role: 'system', content: this._systemPrompt }];
    }

    this.emit('ready');
  }

  override send(message: string): void {
    if (!this._running) {
      this.emit('error', 'Session is not running.');
      return;
    }
    if (this._busy) return;

    this._busy = true;
    this._chatHistory = [...this._chatHistory, { role: 'user', content: message }];

    // Also push to parent history via emit chain — emit thinking first
    this.emit('thinking');

    this.streamResponse().catch((err: unknown) => {
      this._busy = false;
      this.emit('error', err instanceof Error ? err.message : String(err));
    });
  }

  override terminate(): void {
    this._abortController?.abort();
    this._abortController = null;
    this._running = false;
    this._busy = false;
    this._chatHistory = [];
  }

  /**
   * Build the messages array for the Ollama API call.
   * Re-injects the system prompt every REINFORCE_INTERVAL user turns
   * to prevent open-source models from "forgetting" their persona.
   */
  private buildMessagesForApi(): readonly OllamaChatMessage[] {
    if (this._systemPrompt === null || this._systemPrompt.length === 0) {
      return this._chatHistory;
    }

    const REINFORCE_INTERVAL = 4; // re-inject system every 4 user turns
    const userTurnCount = this._chatHistory.filter(m => m.role === 'user').length;
    const needsReinforce = userTurnCount > 1 && userTurnCount % REINFORCE_INTERVAL === 0;

    if (!needsReinforce) {
      return this._chatHistory;
    }

    // Insert a system reminder before the last user message
    const messages = [...this._chatHistory];
    const lastUserIdx = messages.length - 1; // last message is always the new user msg
    const reminder: OllamaChatMessage = {
      role: 'system',
      content: `[REMINDER] Stay in character. ${this._systemPrompt.split('\n')[0]} Never reveal your underlying model name or say you are an AI assistant. You are the character described in your system prompt.`,
    };
    messages.splice(lastUserIdx, 0, reminder);
    return messages;
  }

  private async streamResponse(): Promise<void> {
    this._abortController = new AbortController();

    const messages = this.buildMessagesForApi();

    let response: Response;
    try {
      response = await fetch(OLLAMA_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this._model,
          messages,
          stream: true,
        }),
        signal: this._abortController.signal,
      });
    } catch (err: unknown) {
      this._busy = false;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('aborted') || msg.includes('abort')) return;
      this.emit('error', `Ollama connection failed: ${msg}. Is Ollama running?`);
      return;
    }

    if (!response.ok) {
      this._busy = false;
      this.emit('error', `Ollama returned HTTP ${response.status}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      this._busy = false;
      this.emit('error', 'No response body from Ollama');
      return;
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(trimmed);
          } catch {
            log.warn({ raw: trimmed }, 'Failed to parse Ollama chunk');
            continue;
          }

          if (chunk.error) {
            this._busy = false;
            this.emit('error', chunk.error);
            return;
          }

          const text = chunk.message?.content ?? '';
          if (text) {
            fullContent += text;
            this.emit('text', text);
          }

          if (chunk.done) {
            this._busy = false;
            this._chatHistory = [
              ...this._chatHistory,
              { role: 'assistant', content: fullContent },
            ];
            this.emit('complete');
            return;
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('aborted') && !msg.includes('abort')) {
        this.emit('error', `Stream error: ${msg}`);
      }
    } finally {
      this._busy = false;
      reader.releaseLock();
    }
  }

  // Sync history with parent AgentSession's history for /copy command etc.
  override get history(): readonly AgentMessage[] {
    return this._chatHistory
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: Date.now(),
      }));
  }
}
