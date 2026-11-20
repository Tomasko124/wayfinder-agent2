import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { runAgent } from './agent.js';
import { AnthropicClient } from './llm-anthropic.js';
const file = process.argv[2];
if (!file) { console.error('Usage: npm run agent -- examples/lisbon-slow.json'); process.exitCode = 2; }
else { try { const request = JSON.parse(await readFile(file, 'utf8')); const result = await runAgent(request, { llm: new AnthropicClient() }); console.log(JSON.stringify(result, null, 2)); if (result.status !== 'success') process.exitCode = 1; } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; } }
