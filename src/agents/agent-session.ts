import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import { ProviderType, AgentMessage, ParsedEvent } from '../shared/types';
import { findBinary, buildSessionEnv } from '../main/shell-environment';
import { createLogger } from '../shared/logger';

const log = createLogger('AgentSession');

export abstract class AgentSession extends EventEmitter {
  abstract readonly provider: ProviderType;

  private process: ChildProcess | null = null;
  private lineBuffer: string = '';
  private _isRunning: boolean = false;
  private _isBusy: boolean = false;
  private _history: AgentMessage[] = [];
  protected _systemPrompt: string | null = null;

  get isRunning(): boolean { return this._isRunning; }
  get isBusy(): boolean { return this._isBusy; }
  get history(): readonly AgentMessage[] { return this._history; }

  setSystemPrompt(prompt: string): void {
    this._systemPrompt = prompt;
  }

  abstract buildArgs(): string[];
  abstract parseLine(line: string): ParsedEvent | null;

  start(): void {
    if (this._isRunning) return;

    const binaryPath = findBinary(this.provider);
    if (!binaryPath) {
      this.emit('error', `${this.provider} CLI not found. Please install it and ensure it's in your PATH.`);
      return;
    }

    const args = this.buildArgs();
    const env = buildSessionEnv();

    try {
      this.process = spawn(binaryPath, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });
    } catch (err) {
      this.emit('error', `Failed to start ${this.provider}: ${err}`);
      return;
    }

    this._isRunning = true;

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.onData(chunk.toString('utf-8'));
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        log.error({ provider: this.provider, stderr: text }, 'Agent process stderr output');
      }
    });

    this.process.on('exit', (code) => {
      this._isRunning = false;
      this._isBusy = false;
      this.emit('exit', code);
    });

    this.process.on('error', (err) => {
      this._isRunning = false;
      this.emit('error', `Process error: ${err.message}`);
    });

    this.emit('ready');
  }

  send(message: string): void {
    if (!this.process || !this._isRunning) {
      this.emit('error', 'Session is not running.');
      return;
    }

    this._isBusy = true;
    this._history = [
      ...this._history,
      { role: 'user', content: message, timestamp: Date.now() },
    ];

    this.emit('thinking');
    this.writeToProcess(message);
  }

  terminate(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._isRunning = false;
    this._isBusy = false;
    this.lineBuffer = '';
  }

  clearHistory(): void {
    this._history = [];
  }

  restoreHistory(messages: readonly AgentMessage[]): void {
    this._history = [...messages];
  }

  protected writeToProcess(message: string): void {
    this.process?.stdin?.write(message + '\n');
  }

  private onData(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const event = this.parseLine(trimmed);
      if (!event) continue;

      this.handleParsedEvent(event);
    }
  }

  private handleParsedEvent(event: ParsedEvent): void {
    switch (event.type) {
      case 'text':
        this.emit('text', event.content ?? '');
        break;
      case 'tool-use':
        this.emit('tool-use', event.toolName ?? 'unknown', event.content);
        break;
      case 'tool-result':
        this.emit('tool-result', event.toolName ?? 'unknown', event.content);
        break;
      case 'thinking':
        this.emit('thinking');
        break;
      case 'complete': {
        this._isBusy = false;
        const assistantContent = event.content ?? '';
        if (assistantContent) {
          this._history = [
            ...this._history,
            { role: 'assistant', content: assistantContent, timestamp: Date.now() },
          ];
        }
        this.emit('complete');
        break;
      }
      case 'error':
        this._isBusy = false;
        this.emit('error', event.content ?? 'Unknown error');
        break;
      case 'ready':
        this.emit('ready');
        break;
    }
  }
}
