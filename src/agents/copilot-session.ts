import { AgentSession } from './agent-session';
import { ProviderType, ParsedEvent } from '../shared/types';

export class CopilotSession extends AgentSession {
  readonly provider: ProviderType = 'copilot';

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

    const type = data.type;

    if (type === 'models_response' || type === 'content') {
      const text = data.body ?? data.content ?? '';
      if (text) {
        this.accumulatedText += text;
        return { type: 'text', content: text };
      }
    }

    if (type === 'confirmation') {
      return {
        type: 'tool-use',
        toolName: data.title ?? 'action',
        content: data.message ?? '',
      };
    }

    if (type === 'done' || type === 'end') {
      const content = this.accumulatedText;
      this.accumulatedText = '';
      return { type: 'complete', content };
    }

    if (type === 'error') {
      return { type: 'error', content: data.message ?? 'Unknown error' };
    }

    return null;
  }
}
