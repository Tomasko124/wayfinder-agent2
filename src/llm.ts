import type { LLMClient } from './agent.js';
import { AnthropicClient, MODEL as ANTHROPIC_MODEL } from './llm-anthropic.js';
import { OpenAICompatibleClient } from './openai-compatible.js';

export type LlmProvider = 'openai-compatible' | 'anthropic';
export function createLlmClient(): { client: LLMClient; provider: LlmProvider; model: string } {
  if (process.env.LLM_PROVIDER === 'anthropic') return { client: new AnthropicClient(), provider: 'anthropic', model: ANTHROPIC_MODEL };
  const client = new OpenAICompatibleClient();
  return { client, provider: 'openai-compatible', model: client.model };
}
