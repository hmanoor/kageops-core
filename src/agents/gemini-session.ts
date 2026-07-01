import { AgentSession } from './agent-session';
import { ProviderType, ParsedEvent } from '../shared/types';

export class GeminiSession extends AgentSession {
  readonly provider: ProviderType = 'gemini';

  private accumulatedText: string = '';

  buildArgs(): string[] {
    return [];
  }

  parseLine(line: string): ParsedEvent | null {
    // Gemini uses hybrid JSON/plaintext parsing
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      // Plain text output — treat as response text
      if (line.trim()) {
        this.accumulatedText += line + '\n';
        return { type: 'text', content: line + '\n' };
      }
      return null;
    }

    // JSON line — look for known keys
    if (data.result !== undefined) {
      const text = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
      this.accumulatedText += text;
      const content = this.accumulatedText;
      this.accumulatedText = '';
      return { type: 'complete', content };
    }

    if (data.text !== undefined) {
      const text = data.text;
      this.accumulatedText += text;
      return { type: 'text', content: text };
    }

    if (data.tool_use) {
      return {
        type: 'tool-use',
        toolName: data.tool_use.name ?? 'tool',
        content: JSON.stringify(data.tool_use.input ?? {}),
      };
    }

    if (data.error) {
      return { type: 'error', content: data.error };
    }

    return null;
  }
}
