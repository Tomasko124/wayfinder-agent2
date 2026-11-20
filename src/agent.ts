import { performance } from 'node:perf_hooks';
import { TravelRequestSchema, ItinerarySchema, type TravelRequest, type Itinerary } from './types.js';
import { createToolbox } from './tools.js';
import type { Trace, TraceEvent } from './trace.js';

export type LLMMessage = { role: 'user'|'assistant'; content: unknown };
export type LLMClient = { complete(args: { system: string; messages: LLMMessage[]; tools: unknown[]; maxTokens: number }): Promise<{ content: Array<any>; stop_reason: string | null; usage: { input_tokens?: number; output_tokens?: number } }> };
export type AgentResult = { status: 'success'; itinerary: Itinerary; trace: Trace } | { status: 'needs_clarification'; question: string; trace: Trace } | { status: 'failed'; reason: 'max_iterations'|'llm_error'|'no_terminal_tool'; message: string; trace: Trace };
const system = `You are a travel-planner agent. Gather weather, flights, lodging, and attractions first (independent tool calls together). Select affordable options leaving room for activities and allowance; use calendar_day_planner. On over_budget, choose cheaper options or slower pace and retry. On bad_input fix arguments. On no_results relax constraints or ask one concise clarification if destination unsupported or budget below minimumPossible. Never invent prices or ids. Always finish with submit_itinerary or ask_clarification, never plain text.`;
export async function runAgent(request: unknown, options: { llm: LLMClient; maxIterations?: number; maxTokens?: number; onEvent?: (event: TraceEvent) => void }): Promise<AgentResult> {
 const trace: Trace = []; let seq = 0; const emit = (event: Omit<TraceEvent,'seq'|'timestamp'>) => { const full = { ...event, seq: ++seq, timestamp: new Date().toISOString() } as TraceEvent; trace.push(full); options.onEvent?.(full); };
 const parsed = TravelRequestSchema.safeParse(request); if (!parsed.success) { const question = `Please correct the travel request: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`; emit({ iteration: 0, type: 'request', input: request, output: question, isError: true }); emit({ iteration: 0, type: 'clarification', output: question }); return { status: 'needs_clarification', question, trace }; }
 const trip: TravelRequest = parsed.data; emit({ iteration: 0, type: 'request', input: trip }); const toolbox = createToolbox(); const messages: LLMMessage[] = [{ role: 'user', content: `Plan this trip using tools: ${JSON.stringify(trip)}` }]; let textOnly = 0;
 for (let iteration = 1; iteration <= (options.maxIterations ?? 12); iteration++) {
  let response; const started = performance.now(); try { response = await options.llm.complete({ system, messages, tools: toolbox.definitions, maxTokens: options.maxTokens ?? 1800 }); } catch (error) { const message = error instanceof Error ? error.message : String(error); emit({ iteration, type: 'failed', output: message, durationMs: performance.now() - started }); return { status: 'failed', reason: 'llm_error', message, trace }; }
  const blocks = response.content ?? []; const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); const uses = blocks.filter((b) => b.type === 'tool_use'); emit({ iteration, type: 'llm_turn', text: texts, output: uses.map((x) => x.name), durationMs: performance.now() - started, usage: response.usage }); messages.push({ role: 'assistant', content: blocks });
  if (!uses.length) { textOnly++; if (textOnly <= 2) { emit({ iteration, type: 'nudge', output: 'Use a terminal tool: submit_itinerary or ask_clarification.' }); messages.push({ role: 'user', content: 'Continue with the required terminal tool. Do not answer in plain text.' }); continue; } emit({ iteration, type: 'failed', output: 'No terminal tool was called after two nudges.' }); return { status: 'failed', reason: 'no_terminal_tool', message: 'Model answered with plain text more than twice.', trace }; }
  const results = [];
  for (const use of uses) { emit({ iteration, type: 'tool_call', tool: use.name, input: use.input }); const result = await toolbox.execute(use.name, use.input); const failed = result.status === 'error'; emit({ iteration, type: 'tool_result', tool: use.name, output: result, isError: failed }); if (use.name === 'ask_clarification' && !failed) { const question = (result.data as { question: string }).question; emit({ iteration, type: 'clarification', tool: use.name, output: question }); return { status: 'needs_clarification', question, trace }; } if (use.name === 'submit_itinerary' && !failed) { const itinerary = ItinerarySchema.parse(result.data); emit({ iteration, type: 'final', tool: use.name, output: itinerary }); return { status: 'success', itinerary, trace }; } results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result), is_error: failed }); }
  messages.push({ role: 'user', content: results });
 }
 const message = `Stopped after ${options.maxIterations ?? 12} iterations.`; emit({ iteration: options.maxIterations ?? 12, type: 'failed', output: message }); return { status: 'failed', reason: 'max_iterations', message, trace };
}
export const __agentInternals = { system };
export function isItinerary(value: unknown): value is Itinerary { return ItinerarySchema.safeParse(value).success; }
export type { TravelRequest };
export type { ToolResult } from './tools.js';
