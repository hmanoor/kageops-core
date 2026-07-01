import { AgentSession } from './agent-session';
import { ProviderType, ParsedEvent } from '../shared/types';

export class CodexSession extends AgentSession {
  readonly provider: ProviderType = 'codex';

  private accumulatedText: string = '';

  buildArgs(): string[] {
    return ['--full-auto'];
  }

  parseLine(line: string): ParsedEvent | null {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      // Codex may output plain text
      if (line.trim()) {
        this.accumulatedText += line + '\n';
        return { type: 'text', content: line + '\n' };
      }
      return null;
    }

    if (data.type === 'message' && data.content) {
      this.accumulatedText += data.content;
      return { type: 'text', content: data.content };
    }

    if (data.type === 'function_call' || data.type === 'tool_call') {
      return {
        type: 'tool-use',
        toolName: data.name ?? 'tool',
        content: data.arguments ?? '',
      };
    }

    if (data.type === 'function_result' || data.type === 'tool_result') {
      return {
        type: 'tool-result',
        toolName: data.name ?? 'tool',
        content: data.output ?? '',
      };
    }

    if (data.type === 'done' || data.type === 'end') {
      const content = this.accumulatedText;
      this.accumulatedText = '';
      return { type: 'complete', content };
    }

    if (data.type === 'error') {
      return { type: 'error', content: data.message ?? 'Unknown error' };
    }

    return null;
  }
}
