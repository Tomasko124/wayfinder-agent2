import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runAgent } from '../src/agent.js';
import { AnthropicClient } from '../src/llm-anthropic.js';
import { renderTraceMarkdown } from '../src/trace.js';
const cases = [ ['01-lisbon-slow','examples/lisbon-slow.json'], ['02-kyoto-balanced','examples/kyoto-balanced.json'], ['03-copenhagen-tight-budget','examples/copenhagen-tight-budget.json'], ['04-unknown-destination','examples/unknown-destination.json'] ] as const;
await mkdir('traces', { recursive: true });
for (const [name, file] of cases) {
 const request = JSON.parse(await readFile(file, 'utf8'));
 const result = await runAgent(request, { llm: new AnthropicClient() });
 if (name.startsWith('01') && result.status !== 'success') throw new Error('Run 01 must succeed');
 if (name.startsWith('02') && result.status !== 'success') throw new Error('Run 02 must succeed');
 if (name.startsWith('03') && !(result.status === 'success' && result.trace.some((e) => e.type === 'tool_result' && e.isError) && result.trace.some((e) => e.type === 'final'))) throw new Error('Run 03 must show an error result followed by success');
 if (name.startsWith('04') && result.status !== 'needs_clarification') throw new Error('Run 04 must end in clarification');
 await writeFile(`traces/${name}.json`, JSON.stringify(result, null, 2) + '\n');
 await writeFile(`traces/${name}.md`, renderTraceMarkdown(name, result.trace, result.status) + '\n');
 console.log(`${name}: ${result.status}`);
}
