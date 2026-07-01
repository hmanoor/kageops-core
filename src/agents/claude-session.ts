import { AgentSession } from './agent-session';
import { ProviderType, ParsedEvent } from '../shared/types';

export class ClaudeSession extends AgentSession {
  readonly provider: ProviderType = 'claude';

  private accumulatedText: string = '';

  buildArgs(): string[] {
    const args = ['--output-format', 'stream-json', '--verbose'];
    if (this._systemPrompt !== null && this._systemPrompt.length > 0) {
      args.push('--system-prompt', this._systemPrompt);
    }
    return args;
  }

  parseLine(line: string): ParsedEvent | null {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      return null;
    }

    const type = data.type;

    if (type === 'system' && data.subtype === 'init') {
      return { type: 'ready' };
    }

    if (type === 'assistant' && data.subtype === 'text') {
      const text = data.text ?? '';
      this.accumulatedText += text;
      return { type: 'text', content: text };
    }

    if (type === 'assistant' && data.subtype === 'tool_use') {
      return {
        type: 'tool-use',
        toolName: data.tool_name ?? data.name ?? 'tool',
        content: JSON.stringify(data.input ?? {}),
      };
    }

    if (type === 'result') {
      const content = this.accumulatedText;
      this.accumulatedText = '';
      return { type: 'complete', content };
    }

    return null;
  }
}
