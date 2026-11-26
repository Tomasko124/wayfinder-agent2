import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { runAgent } from './agent.js';
import { createLlmClient } from './llm.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run agent -- examples/lisbon-slow.json');
  process.exitCode = 2;
} else {
  try {
    const request = JSON.parse(await readFile(file, 'utf8'));
    const { client } = createLlmClient();
    const result = await runAgent(request, {
      llm: client,
      onEvent: (event) => console.log(`[${event.iteration}] ${event.type}${event.tool ? `: ${event.tool}` : ''}`),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'success') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
