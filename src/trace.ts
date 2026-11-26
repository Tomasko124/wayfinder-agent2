export type TraceEvent = { seq: number; iteration: number; timestamp: string; type: 'request'|'llm_turn'|'tool_call'|'tool_result'|'nudge'|'clarification'|'final'|'failed'; tool?: string; input?: unknown; output?: unknown; isError?: boolean; durationMs?: number; usage?: { input_tokens?: number; output_tokens?: number }; text?: string };
export type Trace = TraceEvent[];
export type TraceLlmMetadata = { provider: string; model: string };
export function renderTraceMarkdown(title: string, trace: Trace, result: unknown, llm?: TraceLlmMetadata): string {
  const llmLine = llm ? `\n**LLM:** ${llm.provider} — ${llm.model}\n` : '';
  return `# ${title}\n${llmLine}\n**Result:** \`${JSON.stringify(result)}\`\n\n| # | Iteration | Event | Tool | Duration | Details |\n|---:|---:|---|---|---:|---|\n${trace.map((event) => `| ${event.seq} | ${event.iteration} | ${event.type} | ${event.tool ?? ''} | ${event.durationMs ?? ''} | ${JSON.stringify(event.output ?? event.input ?? event.text ?? '').replace(/\|/g, '\\|')} |`).join('\n')}\n`;
}
