import { AgentSession } from './agent-session';
import { ProviderType, ParsedEvent } from '../shared/types';

export class OpenCodeSession extends AgentSession {
  readonly provider: ProviderType = 'opencode';

  private accumulatedText: string = '';

  buildArgs(): string[] {
    return [];
  }

  parseLine(line: string): ParsedEvent | null {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      if (line.trim()) {
        this.accumulatedText += line + '\n';
        return { type: 'text', content: line + '\n' };
      }
      return null;
    }

    const event = data.event;

    if (event === 'content.delta') {
      const text = data.data?.delta ?? data.content ?? '';
      if (text) {
        this.accumulatedText += text;
        return { type: 'text', content: text };
      }
    }

    if (event === 'tool.start') {
      return {
        type: 'tool-use',
        toolName: data.data?.name ?? 'tool',
        content: JSON.stringify(data.data?.input ?? {}),
      };
    }

    if (event === 'tool.result') {
      return {
        type: 'tool-result',
        toolName: data.data?.name ?? 'tool',
        content: data.data?.output ?? '',
      };
    }

    if (event === 'content.done' || event === 'done') {
      const content = this.accumulatedText;
      this.accumulatedText = '';
      return { type: 'complete', content };
    }

    if (event === 'error') {
      return { type: 'error', content: data.data?.message ?? 'Unknown error' };
    }

    return null;
  }
}
