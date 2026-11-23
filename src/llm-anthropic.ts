import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient } from './agent.js';
export const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
export class AnthropicClient implements LLMClient {
 private client: Anthropic;
 constructor(apiKey = process.env.ANTHROPIC_API_KEY) { if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY in the environment or .env file.'); this.client = new Anthropic({ apiKey }); }
 async complete({ system, messages, tools, maxTokens }: Parameters<LLMClient['complete']>[0]) {
  const response = await this.client.messages.create({ model: MODEL, max_tokens: maxTokens, system, messages: messages as Anthropic.MessageParam[], tools: tools as Anthropic.Tool[] });
  return { content: response.content, stop_reason: response.stop_reason, usage: response.usage };
 }
}
