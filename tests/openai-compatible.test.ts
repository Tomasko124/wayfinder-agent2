import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleClient } from '../src/openai-compatible.js';

const toolDefinitions = [{ name: 'weather_lookup', description: 'Look up weather', input_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { city: { type: 'string' } } } }];
const successfulResponse = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible client', () => {
  it('converts system, assistant tool calls, tool results, tool schemas, and request settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: 'Checking weather.', tool_calls: [] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenAICompatibleClient({ baseUrl: 'http://localhost:11434/v1/', model: 'qwen-test', timeoutMs: 240_000 });
    await client.complete({
      system: 'System instructions',
      messages: [
        { role: 'user', content: 'Plan my trip.' },
        { role: 'assistant', content: [{ type: 'text', text: 'I will check.' }, { type: 'tool_use', id: 'call-1', name: 'weather_lookup', input: { city: 'Kyoto' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"status":"success"}' }] },
      ],
      tools: toolDefinitions,
      maxTokens: 1200,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(String(init.body));
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(1200);
    expect(body.messages).toEqual([
      { role: 'system', content: 'System instructions' },
      { role: 'user', content: 'Plan my trip.' },
      { role: 'assistant', content: 'I will check.', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather_lookup', arguments: '{"city":"Kyoto"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"status":"success"}' },
    ]);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'weather_lookup', description: 'Look up weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
  });

  it('parses tool_calls, preserves invalid JSON arguments, and supplies fallback ids', async () => {
    const payload = { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'provider-id', function: { name: 'weather_lookup', arguments: '{"city":"Lisbon"}' } },
      { function: { name: 'weather_lookup', arguments: '{not json' } },
    ] } }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse(payload)));
    const result = await new OpenAICompatibleClient().complete({ system: 's', messages: [], tools: [], maxTokens: 100 });
    expect(result.content[0]).toMatchObject({ type: 'tool_use', id: 'provider-id', name: 'weather_lookup', input: { city: 'Lisbon' } });
    expect(result.content[1]).toMatchObject({ type: 'tool_use', name: 'weather_lookup', input: '{not json' });
    expect(result.content[1].id).toMatch(/^call-/);
    expect(result.stop_reason).toBe('tool_use');
  });

  it.each([
    ['tool_calls', 'tool_use'],
    ['length', 'max_tokens'],
    ['stop', 'end_turn'],
    [null, 'end_turn'],
  ])('maps finish_reason %s to %s', async (finish_reason, stop_reason) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ choices: [{ finish_reason, message: { content: 'Done' } }], usage: { prompt_tokens: 17, completion_tokens: 9 } })));
    const result = await new OpenAICompatibleClient().complete({ system: 's', messages: [], tools: [], maxTokens: 100 });
    expect(result.stop_reason).toBe(stop_reason);
    expect(result.content).toEqual([{ type: 'text', text: 'Done' }]);
    expect(result.usage).toEqual({ input_tokens: 17, output_tokens: 9 });
  });

  it('sends a bearer token only when configured and never leaks it in HTTP errors', async () => {
    const secret = 'test-secret-token';
    const fetchMock = vi.fn().mockResolvedValue(new Response(`Rejected ${secret}`, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenAICompatibleClient({ apiKey: secret });
    let errorMessage = '';
    try { await client.complete({ system: 's', messages: [], tools: [], maxTokens: 10 }); }
    catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
    expect(errorMessage).toBe('LLM request failed with HTTP 401: Rejected [redacted]');
    expect(errorMessage).not.toContain(secret);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
  });
});
