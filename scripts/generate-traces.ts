import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runAgent } from '../src/agent.js';
import { createLlmClient } from '../src/llm.js';
import { renderTraceMarkdown } from '../src/trace.js';

const cases = [
  ['01-lisbon-slow', 'examples/lisbon-slow.json'],
  ['02-kyoto-balanced', 'examples/kyoto-balanced.json'],
  ['03-copenhagen-tight-budget', 'examples/copenhagen-tight-budget.json'],
  ['04-unknown-destination', 'examples/unknown-destination.json'],
] as const;

await mkdir('traces', { recursive: true });
for (const [name, file] of cases) {
  const request = JSON.parse(await readFile(file, 'utf8'));
  const { client, provider, model } = createLlmClient();
  const llm = { provider, model };
  const result = await runAgent(request, { llm: client });
  const tracedResult = { ...result, llm };

  await writeFile(`traces/${name}.json`, JSON.stringify(tracedResult, null, 2) + '\n');
  await writeFile(`traces/${name}.md`, renderTraceMarkdown(name, result.trace, result.status, llm) + '\n');
  console.log(`${name}: ${result.status}`);

  if (name.startsWith('01') && result.status !== 'success') throw new Error(`Run 01 failed: expected success status, received ${result.status}.`);
  if (name.startsWith('02') && result.status !== 'success') throw new Error(`Run 02 failed: expected success status, received ${result.status}.`);
  if (name.startsWith('03')) {
    if (result.status !== 'success') throw new Error(`Run 03 failed: expected success status, received ${result.status}.`);
    const finalIndex = result.trace.findIndex((event) => event.type === 'final');
    if (finalIndex === -1) throw new Error('Run 03 failed: no final event was recorded.');
    const overBudgetIndex = result.trace.findIndex((event) => {
      if (event.type !== 'tool_result' || event.tool !== 'calendar_day_planner') return false;
      const output = event.output as { status?: string; errorType?: string } | undefined;
      return output?.status === 'error' && output.errorType === 'over_budget';
    });
    if (overBudgetIndex === -1) throw new Error('Run 03 failed: no calendar_day_planner over_budget tool result was recorded.');
    if (overBudgetIndex >= finalIndex) throw new Error('Run 03 failed: calendar_day_planner over_budget result did not occur before the final event.');
  }
  if (name.startsWith('04') && result.status !== 'needs_clarification') throw new Error(`Run 04 failed: expected needs_clarification status, received ${result.status}.`);
}
