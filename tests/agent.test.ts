import { describe, expect, it } from 'vitest';
import { runAgent, type LLMClient } from '../src/agent.js';
import { createToolbox } from '../src/tools.js';

const request = { destination: 'Lisbon', startDate: '2026-05-10', endDate: '2026-05-12', budget: 1500, preferences: { pace: 'slow', interests: ['history'], dietary: 'vegetarian' } };
const toolCall = (name: string, input: unknown, id = name) => ({ type: 'tool_use', id, name, input });
const answer = (...content: unknown[]) => ({ content, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } });
function scripted(responses: unknown[]): LLMClient {
  return { complete: async () => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value as Awaited<ReturnType<LLMClient['complete']>>;
  } };
}
const plannerInput = (overrides: Record<string, unknown> = {}) => ({
  destination: 'Lisbon', startDate: '2026-05-10', endDate: '2026-05-12', budget: 1500, pace: 'slow', interests: [], dietary: 'none', flightId: 'lis-flight-saver', lodgingId: 'lisbon-budget', ...overrides,
});

describe('tools', () => {
  it('returns deterministic weather and condition/rain consistency', async () => {
    const box = createToolbox();
    const input = { destination: 'lIsBoN', startDate: '2026-05-10', endDate: '2026-05-12' };
    const first = await box.execute('weather_lookup', input);
    expect(await box.execute('weather_lookup', input)).toEqual(first);
    expect(first.status).toBe('success');
    if (first.status === 'success') for (const day of first.data as any[]) {
      expect(day.rainy).toBe(day.rainChance >= 50);
      expect(day.rainy ? ['Rain', 'Showers'] : ['Sunny', 'Cloudy']).toContain(day.condition);
    }
  });

  it('returns destination-specific flight catalogs and validates caps and dates', async () => {
    const box = createToolbox();
    const input = { destination: 'LISBON', startDate: '2026-05-10', endDate: '2026-05-12' };
    const lisbon = await box.execute('flight_price_lookup', input);
    const kyoto = await box.execute('flight_price_lookup', { ...input, destination: 'Kyoto' });
    expect(lisbon.status).toBe('success');
    expect(kyoto.status).toBe('success');
    if (lisbon.status === 'success' && kyoto.status === 'success') expect(lisbon.data).not.toEqual(kyoto.data);
    expect(await box.execute('flight_price_lookup', { ...input, maxPrice: 1 })).toMatchObject({ status: 'error', errorType: 'no_results' });
    expect(await box.execute('flight_price_lookup', { ...input, endDate: '2026-05-01' })).toMatchObject({ status: 'error', errorType: 'bad_input' });
  });

  it('returns no_results with supported city names for every city-dependent tool', async () => {
    const box = createToolbox();
    const invalid = { destination: 'Reykjavik', startDate: '2026-05-10', endDate: '2026-05-12' };
    const inputs: Array<[string, unknown]> = [
      ['weather_lookup', invalid], ['flight_price_lookup', invalid], ['lodging_lookup', invalid],
      ['attractions_lookup', { destination: 'Reykjavik', interests: [], dietary: 'none' }],
      ['calendar_day_planner', plannerInput({ destination: 'Reykjavik' })],
    ];
    for (const [name, input] of inputs) {
      const result = await box.execute(name, input);
      expect(result).toMatchObject({ status: 'error', errorType: 'no_results' });
      if (result.status === 'error') expect(result.message).toContain('Lisbon, Kyoto, Copenhagen');
    }
  });

  it('normalizes city casing and rejects cross-destination flights', async () => {
    const box = createToolbox();
    expect((await box.execute('lodging_lookup', { destination: 'kYoto', startDate: '2026-05-10', endDate: '2026-05-12' })).status).toBe('success');
    expect(await box.execute('calendar_day_planner', plannerInput({ flightId: 'kyo-flight-saver' }))).toMatchObject({ status: 'error', errorType: 'bad_input' });
  });

  it('returns planner over-budget details and submit cannot alter stored totals', async () => {
    const box = createToolbox();
    expect(await box.execute('calendar_day_planner', plannerInput({ budget: 1 }))).toMatchObject({ status: 'error', errorType: 'over_budget', details: { estimated: expect.any(Number), minimumPossible: expect.any(Number) } });
    const planned = await box.execute('calendar_day_planner', plannerInput());
    if (planned.status !== 'success') throw new Error('Expected stored plan');
    const submitted = await box.execute('submit_itinerary', { planId: (planned.data as any).planId, summary: 'A trip', tips: [] });
    expect(submitted.status).toBe('success');
    if (submitted.status === 'success') expect((submitted.data as any).totals.estimated).toBe((planned.data as any).preview.estimated);
  });

  it('pace sets the number of day items', async () => {
    const box = createToolbox();
    const s = await box.execute('calendar_day_planner', plannerInput({ pace: 'slow' }));
    const f = await box.execute('calendar_day_planner', plannerInput({ pace: 'full' }));
    if (s.status !== 'success' || f.status !== 'success') throw new Error('Expected plans');
    const [slowItinerary, fullItinerary] = await Promise.all([
      box.execute('submit_itinerary', { planId: (s.data as any).planId, summary: '', tips: [] }),
      box.execute('submit_itinerary', { planId: (f.data as any).planId, summary: '', tips: [] }),
    ]);
    expect((slowItinerary as any).data.days.map((day: any) => day.items.length)).toEqual([2, 2, 2]);
    expect((fullItinerary as any).data.days.map((day: any) => day.items.length)).toEqual([4, 4, 4]);
  });

  it('rainy days prefer indoor activities', async () => {
    const box = createToolbox();
    const weather = await box.execute('weather_lookup', { destination: 'Lisbon', startDate: '2026-05-10', endDate: '2026-05-15' });
    if (weather.status !== 'success') throw new Error('Expected forecast');
    const days = weather.data as any[];
    const rainy = days.find((day) => day.rainy);
    expect(rainy).toBeDefined();
    const plan = await box.execute('calendar_day_planner', plannerInput({ startDate: rainy.date, endDate: rainy.date }));
    if (plan.status !== 'success') throw new Error('Expected rainy-day itinerary');
    const submitted = await box.execute('submit_itinerary', { planId: (plan.data as any).planId, summary: '', tips: [] });
    expect((submitted as any).data.days[0].items[0].indoor).toBe(true);
  });

  it('interests change activity ranking and gluten-free requests filter food', async () => {
    const box = createToolbox();
    const history = await box.execute('calendar_day_planner', plannerInput({ interests: ['history'] }));
    const art = await box.execute('calendar_day_planner', plannerInput({ interests: ['art'] }));
    if (history.status !== 'success' || art.status !== 'success') throw new Error('Expected plans');
    const historyPlan = await box.execute('submit_itinerary', { planId: (history.data as any).planId, summary: '', tips: [] });
    const artPlan = await box.execute('submit_itinerary', { planId: (art.data as any).planId, summary: '', tips: [] });
    expect((historyPlan as any).data.days[0].items[0].activityId).not.toBe((artPlan as any).data.days[0].items[0].activityId);
    const glutenFree = await box.execute('calendar_day_planner', plannerInput({ destination: 'Kyoto', flightId: 'kyo-flight-saver', lodgingId: 'kyoto-budget', dietary: 'gluten-free', pace: 'full', activityIds: ['market', 'soba', 'temple', 'tea'] }));
    if (glutenFree.status !== 'success') throw new Error('Expected gluten-free plan');
    const itinerary = await box.execute('submit_itinerary', { planId: (glutenFree.data as any).planId, summary: '', tips: [] });
    expect((itinerary as any).data.days.flatMap((day: any) => day.items).filter((item: any) => item.category === 'food').map((item: any) => item.activityId)).toEqual(['market']);
  });
});

describe('agent loop', () => {
  it('succeeds after planner and submit calls', async () => {
    const llm = scripted([
      answer(toolCall('calendar_day_planner', { ...plannerInput(), destination: 'Lisbon' })),
      answer(toolCall('submit_itinerary', { planId: 'plan-1', summary: 'A calm trip.', tips: [] })),
    ]);
    expect((await runAgent(request, { llm })).status).toBe('success');
  });

  it('returns ask_clarification as a terminal outcome', async () => {
    const result = await runAgent(request, { llm: scripted([answer(toolCall('ask_clarification', { question: 'Could you raise your budget?' }))]) });
    expect(result).toMatchObject({ status: 'needs_clarification', question: 'Could you raise your budget?' });
  });

  it('validates requests before calling the LLM', async () => {
    let calls = 0;
    const llm = { complete: async () => { calls++; return answer(); } };
    expect((await runAgent({ ...request, startDate: '2026-02-31' }, { llm })).status).toBe('needs_clarification');
    expect(calls).toBe(0);
  });

  it('retries after tool error and submits a successful itinerary', async () => {
    const llm = scripted([
      answer(toolCall('flight_price_lookup', { destination: 'Lisbon', startDate: '2026-05-10', endDate: '2026-05-12', maxPrice: 2 })),
      answer(toolCall('calendar_day_planner', plannerInput())),
      answer(toolCall('submit_itinerary', { planId: 'plan-1', summary: 'A calm trip.', tips: [] })),
    ]);
    const result = await runAgent(request, { llm });
    expect(result.status).toBe('success');
    expect(result.trace.some((event) => event.type === 'tool_result' && event.isError)).toBe(true);
  });

  it('enforces a real iteration cap when tools keep being called', async () => {
    const llm = { complete: async () => answer(toolCall('weather_lookup', { destination: 'Lisbon', startDate: '2026-05-10', endDate: '2026-05-12' })) };
    const result = await runAgent(request, { llm, maxIterations: 3 });
    expect(result).toMatchObject({ status: 'failed', reason: 'max_iterations' });
    expect(result.trace.filter((event) => event.type === 'llm_turn')).toHaveLength(3);
  });

  it('handles LLM exceptions and nudges plain text twice', async () => {
    expect(await runAgent(request, { llm: scripted([new Error('offline')]) })).toMatchObject({ status: 'failed', reason: 'llm_error' });
    const result = await runAgent(request, { llm: scripted([answer({ type: 'text', text: 'thinking' }), answer({ type: 'text', text: 'again' }), answer({ type: 'text', text: 'done' })]) });
    expect(result).toMatchObject({ status: 'failed', reason: 'no_terminal_tool' });
  });
});

it('returns bad_input for unknown tools and malformed tool inputs', async () => {
  const box = createToolbox();
  expect(await box.execute('missing', {})).toMatchObject({ status: 'error', errorType: 'bad_input' });
  expect(await box.execute('weather_lookup', {})).toMatchObject({ status: 'error', errorType: 'bad_input' });
});

describe('planner budget recovery', () => {
  const copenhagenRequest = { destination: 'Copenhagen', startDate: '2026-07-06', endDate: '2026-07-08', budget: 600, pace: 'balanced', interests: ['design', 'architecture'], dietary: 'vegetarian', flightId: 'cph-flight-saver', lodgingId: 'cph-budget' };

  it('suggests the fitting slow-pace cheapest Copenhagen plan and matches its real planner total', async () => {
    const box = createToolbox();
    const result = await box.execute('calendar_day_planner', copenhagenRequest);
    expect(result).toMatchObject({ status: 'error', errorType: 'over_budget', details: { suggestions: [{ pace: 'slow', flightId: 'cph-flight-saver', lodgingId: 'cph-budget', estimated: 569 }] } });
    if (result.status !== 'error') throw new Error('Expected over_budget result');
    expect(result.message).toContain('Try pace=slow with flightId=cph-flight-saver and lodgingId=cph-budget (estimated €569).');
    const suggestion = (result.details as any).suggestions[0];
    const replanned = await box.execute('calendar_day_planner', { ...copenhagenRequest, pace: suggestion.pace, flightId: suggestion.flightId, lodgingId: suggestion.lodgingId });
    expect(replanned.status).toBe('success');
    if (replanned.status !== 'success') throw new Error('Suggested plan should fit the budget');
    const submitted = await box.execute('submit_itinerary', { planId: (replanned.data as any).planId, summary: '', tips: [] });
    expect((submitted as any).data.totals.estimated).toBe(suggestion.estimated);
  });

  it('rejects an identical call after its earlier budget failure', async () => {
    const box = createToolbox();
    expect(await box.execute('calendar_day_planner', copenhagenRequest)).toMatchObject({ status: 'error', errorType: 'over_budget' });
    expect(await box.execute('calendar_day_planner', copenhagenRequest)).toMatchObject({ status: 'error', errorType: 'bad_input', message: 'Identical to an earlier failed call. Change flightId, lodgingId, pace or activityIds as suggested, or call ask_clarification.' });
  });

  it('returns no suggestions and requests clarification when no pace fits', async () => {
    const result = await createToolbox().execute('calendar_day_planner', { ...copenhagenRequest, budget: 200 });
    expect(result).toMatchObject({ status: 'error', errorType: 'over_budget', details: { suggestions: [] } });
    if (result.status === 'error') expect(result.message).toContain('call ask_clarification and ask the user to raise the budget or shorten the trip.');
  });
});
