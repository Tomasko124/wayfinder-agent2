import { z } from 'zod';
import { dateRange, dateSchema, nightsBetween } from './dates.js';
import { activitiesFor, cities, flights, lodgings, resolveCity, supportedCities, weatherForDates, type Activity } from './data.js';
import { ItinerarySchema, type Itinerary, type ToolResult } from './types.js';

type ToolSpec = { name: string; description: string; schema: z.ZodType; run: (input: any) => unknown };
type Pace = 'slow' | 'balanced' | 'full';
type Flight = (typeof flights)[keyof typeof flights][number];
type Lodging = (typeof lodgings)[keyof typeof lodgings][number];
const dateFields = { startDate: dateSchema, endDate: dateSchema };
const supportedMessage = () => `Unsupported destination. Supported cities: ${supportedCities.join(', ')}.`;
const unsupported = (): never => { throw Object.assign(new Error(supportedMessage()), { errorType: 'no_results', details: { supportedCities } }); };
const interestsScore = (tags: string[], interests: string[]) => tags.reduce((score, tag) => score + (interests.some((interest) => tag.toLowerCase().includes(interest.toLowerCase()) || interest.toLowerCase().includes(tag.toLowerCase())) ? 1 : 0), 0);
const validateDateOrder = ({ startDate, endDate }: { startDate: string; endDate: string }, ctx: z.RefinementCtx) => {
  if (endDate < startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
};

export function createToolbox() {
  const plans = new Map<string, Itinerary>();
  const failedPlannerCalls = new Set<string>();
  let planCounter = 0;
  const specs: ToolSpec[] = [
    {
      name: 'weather_lookup', description: 'Get deterministic per-day weather forecast.',
      schema: z.object({ destination: z.string(), ...dateFields }).superRefine(validateDateOrder),
      run: ({ destination, startDate, endDate }) => {
        if (!resolveCity(destination)) return unsupported();
        dateRange(startDate, endDate);
        return weatherForDates(destination, startDate, endDate);
      },
    },
    {
      name: 'flight_price_lookup', description: 'Find destination-specific flight options, optionally capped at maxPrice.',
      schema: z.object({ origin: z.string().optional(), destination: z.string(), ...dateFields, maxPrice: z.number().positive().optional() }).superRefine(validateDateOrder),
      run: ({ destination, maxPrice }) => {
        const city = resolveCity(destination);
        if (!city) return unsupported();
        const options = flights[city].filter((flight) => maxPrice === undefined || flight.price <= maxPrice);
        if (!options.length) throw Object.assign(new Error(`No flights under cap; cheapest available price is €${flights[city][0].price}.`), { errorType: 'no_results', details: { cheapest: flights[city][0].price } });
        return options;
      },
    },
    {
      name: 'lodging_lookup', description: 'Find lodging by destination and optional nightly cap.',
      schema: z.object({ destination: z.string(), ...dateFields, maxNightlyRate: z.number().positive().optional() }).superRefine(validateDateOrder),
      run: ({ destination, startDate, endDate, maxNightlyRate }) => {
        const city = resolveCity(destination);
        if (!city) return unsupported();
        const nights = nightsBetween(startDate, endDate);
        const options = lodgings[city].filter((item) => maxNightlyRate === undefined || item.nightlyRate <= maxNightlyRate).map((item) => ({ ...item, nights, total: item.nightlyRate * nights }));
        if (!options.length) throw Object.assign(new Error('No lodging under that nightly cap.'), { errorType: 'no_results' });
        return options;
      },
    },
    {
      name: 'attractions_lookup', description: 'Search activities ranked by interests and dietary suitability.',
      schema: z.object({ destination: z.string(), interests: z.array(z.string()).default([]), dietary: z.string().default('none'), pace: z.enum(['slow', 'balanced', 'full']).optional(), indoorOnly: z.boolean().optional() }),
      run: ({ destination, interests, dietary, indoorOnly }) => {
        const city = resolveCity(destination);
        if (!city) return unsupported();
        return activitiesFor(city).filter((activity) => !indoorOnly || activity.indoor).filter((activity) => activity.category !== 'food' || dietary === 'none' || activity.diets.includes(dietary.toLowerCase())).map((activity) => ({ ...activity, interestScore: interestsScore(activity.tags, interests) })).sort((a, b) => b.interestScore - a.interestScore);
      },
    },
    {
      name: 'calendar_day_planner', description: 'Build a preference-aware, budget-checked itinerary and store it behind an opaque planId.',
      schema: z.object({ destination: z.string(), ...dateFields, budget: z.number().positive(), pace: z.enum(['slow', 'balanced', 'full']), interests: z.array(z.string()), dietary: z.string(), flightId: z.string(), lodgingId: z.string(), activityIds: z.array(z.string()).optional() }).superRefine(validateDateOrder),
      run: (request) => {
        const cityName = resolveCity(request.destination);
        if (!cityName) return unsupported();
        const flight = flights[cityName].find((option) => option.id === request.flightId);
        const lodging = lodgings[cityName].find((option) => option.id === request.lodgingId);
        if (!flight) throw Object.assign(new Error(`Unknown flightId for ${cityName}.`), { errorType: 'bad_input' });
        if (!lodging) throw Object.assign(new Error(`Unknown lodgingId for ${cityName}.`), { errorType: 'bad_input' });
        const activities = activitiesFor(cityName);
        if (request.activityIds?.some((id: string) => !activities.some((activity) => activity.id === id))) throw Object.assign(new Error('Unknown activityId.'), { errorType: 'bad_input' });
        const pool: Activity[] = request.activityIds ? request.activityIds.map((id: string) => activities.find((activity) => activity.id === id)!) : activities;

        const buildPlan = ({ pace, flight: selectedFlight, lodging: selectedLodging }: { pace: Pace; flight: Flight; lodging: Lodging }) => {
          const dates = dateRange(request.startDate, request.endDate);
          const weather = weatherForDates(cityName, request.startDate, request.endDate)!;
          const slots = ['morning', 'afternoon', 'evening', 'late'];
          const perDay = pace === 'slow' ? 2 : pace === 'balanced' ? 3 : 4;
          const used = new Set<string>();
          let activityTotal = 0;
          const days = dates.map((date, dayIndex) => {
            const forecast = weather[dayIndex];
            const items: Itinerary['days'][number]['items'] = [];
            let foodStops = 0;
            for (const slot of slots.slice(0, perDay)) {
              const activity = pool.filter((item) => !used.has(item.id) && (item.category !== 'food' || foodStops === 0) && (item.category !== 'food' || request.dietary.toLowerCase() === 'none' || item.diets.includes(request.dietary.toLowerCase()))).sort((a, b) => {
                const score = (item: Activity) => interestsScore(item.tags, request.interests) * 10 + Number(item.bestTime.toLowerCase() === slot) * 5 + Number(forecast.rainy && item.indoor) * 3;
                return score(b) - score(a);
              })[0];
              if (!activity) {
                items.push({ slot, activityId: 'free-time', name: 'Free time', category: 'free_time', cost: 0, durationHours: 0, indoor: forecast.rainy, note: 'Activity pool exhausted; unstructured time has no activity cost.' });
                continue;
              }
              used.add(activity.id);
              if (activity.category === 'food') foodStops++;
              activityTotal += activity.cost;
              items.push({ slot, activityId: activity.id, name: activity.name, category: activity.category, cost: activity.cost, durationHours: activity.durationHours, indoor: activity.indoor, note: `${activity.bestTime === slot ? 'Best time of day.' : 'Flexible timing.'}${forecast.rainy && activity.indoor ? ' Indoor choice for rainy weather.' : ''}` });
            }
            return { date, weather: forecast, items, dayCost: items.reduce((sum, item) => sum + item.cost, 0) + cities[cityName].allowance };
          });
          const nights = nightsBetween(request.startDate, request.endDate);
          const lodgingTotal = selectedLodging.nightlyRate * nights;
          const localAllowance = cities[cityName].allowance * dates.length;
          const estimated = selectedFlight.price + lodgingTotal + activityTotal + localAllowance;
          const itinerary = ItinerarySchema.parse({
            destination: cityName, startDate: request.startDate, endDate: request.endDate, currency: 'EUR',
            flight: { id: selectedFlight.id, airline: selectedFlight.airline, price: selectedFlight.price },
            lodging: { id: selectedLodging.id, name: selectedLodging.name, neighborhood: selectedLodging.neighborhood, nightlyRate: selectedLodging.nightlyRate, nights, total: lodgingTotal },
            days, totals: { flight: selectedFlight.price, lodging: lodgingTotal, activities: activityTotal, localAllowance, estimated, budget: request.budget, remaining: request.budget - estimated },
            notes: ['One traveller; all estimates are in EUR.', 'Free-time items cost €0 and are excluded from activity spend.', 'Activity times are suggested slots; arrival and departure times are not modeled.'], summary: '', tips: [],
          });
          return { itinerary, totals: itinerary.totals };
        };

        const current = buildPlan({ pace: request.pace, flight, lodging });
        if (current.totals.estimated > request.budget) {
          const cheapestFlight = flights[cityName][0];
          const cheapestLodging = lodgings[cityName][0];
          const paceOrder: Pace[] = ['full', 'balanced', 'slow'];
          const paces = paceOrder.slice(paceOrder.indexOf(request.pace));
          const suggestions = paces.map((pace) => {
            const candidate = buildPlan({ pace, flight: cheapestFlight, lodging: cheapestLodging });
            return { pace, flightId: cheapestFlight.id, lodgingId: cheapestLodging.id, estimated: candidate.totals.estimated };
          }).filter((suggestion) => suggestion.estimated <= request.budget);
          const bestSuggestion = suggestions[0];
          const message = bestSuggestion
            ? `Estimated €${current.totals.estimated} exceeds budget €${request.budget}. Try pace=${bestSuggestion.pace} with flightId=${bestSuggestion.flightId} and lodgingId=${bestSuggestion.lodgingId} (estimated €${bestSuggestion.estimated}).`
            : `Estimated €${current.totals.estimated} exceeds budget €${request.budget}. Even the cheapest options exceed the budget; call ask_clarification and ask the user to raise the budget or shorten the trip.`;
          const minimumPossible = cheapestFlight.price + cheapestLodging.nightlyRate * current.itinerary.lodging.nights + current.totals.localAllowance;
          throw Object.assign(new Error(message), { errorType: 'over_budget', details: { estimated: current.totals.estimated, budget: request.budget, overage: current.totals.estimated - request.budget, breakdown: { flight: current.totals.flight, lodging: current.totals.lodging, activities: current.totals.activities, localAllowance: current.totals.localAllowance }, minimumPossible, suggestions } });
        }
        const planId = `plan-${++planCounter}`;
        plans.set(planId, current.itinerary);
        return { planId, preview: { destination: current.itinerary.destination, estimated: current.totals.estimated, budget: request.budget } };
      },
    },
    { name: 'ask_clarification', description: 'Finish by asking one concise clarifying question.', schema: z.object({ question: z.string().min(1) }), run: ({ question }) => ({ question }) },
    { name: 'submit_itinerary', description: 'Finish using a stored planId; prices and totals remain authoritative.', schema: z.object({ planId: z.string(), summary: z.string(), tips: z.array(z.string()) }), run: ({ planId, summary, tips }) => { const plan = plans.get(planId); if (!plan) throw Object.assign(new Error('Unknown planId'), { errorType: 'bad_input' }); return ItinerarySchema.parse({ ...plan, summary, tips }); } },
  ];
  return {
    specs,
    definitions: specs.map(({ name, description, schema }) => ({ name, description, input_schema: z.toJSONSchema(schema) })),
    async execute(name: string, input: unknown): Promise<ToolResult> {
      const spec = specs.find((item) => item.name === name);
      if (!spec) return { status: 'error', errorType: 'bad_input', message: `Unknown tool: ${name}` };
      const parsed = spec.schema.safeParse(input);
      if (!parsed.success) return { status: 'error', errorType: 'bad_input', message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
      const plannerCallKey = name === 'calendar_day_planner' ? JSON.stringify(parsed.data) : undefined;
      if (plannerCallKey && failedPlannerCalls.has(plannerCallKey)) return { status: 'error', errorType: 'bad_input', message: 'Identical to an earlier failed call. Change flightId, lodgingId, pace or activityIds as suggested, or call ask_clarification.' };
      try { return { status: 'success', data: await spec.run(parsed.data) }; }
      catch (error) {
        if (plannerCallKey) failedPlannerCalls.add(plannerCallKey);
        const issue = error as Error & { errorType?: 'bad_input' | 'no_results' | 'over_budget' | 'internal'; details?: unknown };
        return { status: 'error', errorType: issue.errorType ?? 'internal', message: issue.message || 'Tool failed', ...(issue.details ? { details: issue.details } : {}) };
      }
    },
  };
}
export type Toolbox = ReturnType<typeof createToolbox>;
export type { ToolResult };
