import type { LLMClient, LLMMessage } from './agent.js';

type ToolDefinition = { name: string; description?: string; input_schema?: Record<string, unknown> };
type ChatMessage = Record<string, unknown>;

function convertMessages(system: string, messages: LLMMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      result.push({ role: message.role, content: JSON.stringify(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      const text = message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
      const toolCalls = message.content.filter((block: any) => block.type === 'tool_use').map((block: any) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));
      result.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      for (const block of message.content) {
        if (block.type === 'tool_result') result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) });
        else if (block.type === 'text') result.push({ role: 'user', content: block.text });
      }
    }
  }
  return result;
}

function convertTools(tools: unknown[]) {
  return tools.map((value) => {
    const tool = value as ToolDefinition;
    const parameters = { ...(tool.input_schema ?? {}) };
    delete parameters.$schema;
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
  });
}

export class OpenAICompatibleClient implements LLMClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
    this.model = options.model ?? process.env.LLM_MODEL ?? 'qwen2.5:7b';
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async complete({ system, messages, tools, maxTokens }: Parameters<LLMClient['complete']>[0]) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ model: this.model, messages: convertMessages(system, messages), tools: convertTools(tools), temperature: 0, max_tokens: maxTokens }),
    });
    if (!response.ok) {
      const body = await response.text();
      const safeBody = this.apiKey ? body.split(this.apiKey).join('[redacted]') : body;
      throw new Error(`LLM request failed with HTTP ${response.status}: ${safeBody}`);
    }

    const payload = await response.json() as {
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = payload.choices?.[0];
    const content: any[] = [];
    if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content });
    for (const [index, call] of (choice?.message?.tool_calls ?? []).entries()) {
      const rawArguments = call.function?.arguments ?? '';
      let input: unknown;
      try { input = JSON.parse(rawArguments); } catch { input = rawArguments; }
      content.push({ type: 'tool_use', id: call.id || `call-${Date.now()}-${index}`, name: call.function?.name ?? '', input });
    }
    const finishReason = choice?.finish_reason;
    return {
      content,
      stop_reason: finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn',
      usage: { input_tokens: payload.usage?.prompt_tokens, output_tokens: payload.usage?.completion_tokens },
    };
  }
}

export { convertMessages, convertTools };
export type { ChatMessage };
export function getOpenAICompatibleMetadata(client: OpenAICompatibleClient) { return { provider: 'openai-compatible', model: client.model }; }
