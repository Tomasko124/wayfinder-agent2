import { z } from 'zod';
import { dateRange, dateSchema, nightsBetween } from './dates.js';
import { activitiesFor, cities, flights, lodgings, resolveCity, supportedCities, weatherForDates, type Activity } from './data.js';
import { ItinerarySchema, type Itinerary, type ToolResult } from './types.js';

type ToolSpec = { name: string; description: string; schema: z.ZodType; run: (input: any) => unknown };
const dateFields = { startDate: dateSchema, endDate: dateSchema };
const datePeriod = z.object(dateFields).superRefine(({ startDate, endDate }, ctx) => {
  if (endDate < startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
});
const supportedMessage = () => `Unsupported destination. Supported cities: ${supportedCities.join(', ')}.`;
const unsupported = (): never => { throw Object.assign(new Error(supportedMessage()), { errorType: 'no_results', details: { supportedCities } }); };
const interestsScore = (tags: string[], interests: string[]) => tags.reduce((score, tag) => score + (interests.some((interest) => tag.toLowerCase().includes(interest.toLowerCase()) || interest.toLowerCase().includes(tag.toLowerCase())) ? 1 : 0), 0);

export function createToolbox() {
  const plans = new Map<string, Itinerary>();
  const failedPlannerCalls = new Set<string>();
  let planCounter = 0;
  const specs: ToolSpec[] = [
    {
      name: 'weather_lookup', description: 'Get deterministic per-day weather forecast.',
      schema: z.object({ destination: z.string(), ...dateFields }).superRefine(({ startDate, endDate }, ctx) => {
        if (endDate < startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
      }),
      run: ({ destination, startDate, endDate }) => {
        if (!resolveCity(destination)) return unsupported();
        dateRange(startDate, endDate);
        return weatherForDates(destination, startDate, endDate);
      },
    },
    {
      name: 'flight_price_lookup', description: 'Find destination-specific flight options, optionally capped at maxPrice.',
      schema: z.object({ origin: z.string().optional(), destination: z.string(), ...dateFields, maxPrice: z.number().positive().optional() }).superRefine(({ startDate, endDate }, ctx) => {
        if (endDate < startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
      }),
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
      schema: z.object({ destination: z.string(), ...dateFields, maxNightlyRate: z.number().positive().optional() }).superRefine(({ startDate, endDate }, ctx) => {
        if (endDate < startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
      }),
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
      schema: z.object({ destination: z.string(), ...dateFields, budget: z.number().positive(), pace: z.enum(['slow', 'balanced', 'full']), interests: z.array(z.string()), dietary: z.string(), flightId: z.string(), lodgingId: z.string(), activityIds: z.array(z.string()).optional() }).superRefine(({ startDate, endDate }, ctx) => {
        if (endDate < startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
      }),
      run: (input) => {
        const cityName = resolveCity(input.destination);
        if (!cityName) return unsupported();
        const flight = flights[cityName].find((option) => option.id === input.flightId);
        const lodge = lodgings[cityName].find((option) => option.id === input.lodgingId);
        if (!flight) throw Object.assign(new Error(`Unknown flightId for ${cityName}.`), { errorType: 'bad_input' });
        if (!lodge) throw Object.assign(new Error(`Unknown lodgingId for ${cityName}.`), { errorType: 'bad_input' });
        const dates = dateRange(input.startDate, input.endDate);
        const weather = weatherForDates(cityName, input.startDate, input.endDate)!;
        const allActivities = activitiesFor(cityName);
        if (input.activityIds && input.activityIds.some((id: string) => !allActivities.some((activity) => activity.id === id))) throw Object.assign(new Error('Unknown activityId.'), { errorType: 'bad_input' });
        const pool: Activity[] = input.activityIds ? input.activityIds.map((id: string) => allActivities.find((activity) => activity.id === id)!) : allActivities;
        const activityCostForPace = (pace: 'slow' | 'balanced' | 'full') => {
          const paceCount = pace === 'slow' ? 2 : pace === 'balanced' ? 3 : 4;
          const used = new Set<string>();
          let cost = 0;
          dates.forEach((_, dayIndex) => {
            const forecast = weather[dayIndex];
            let foodStops = 0;
            for (const slot of ['morning', 'afternoon', 'evening', 'late'].slice(0, paceCount)) {
              const activity = pool.filter((item) => !used.has(item.id) && (item.category !== 'food' || foodStops === 0) && (item.category !== 'food' || input.dietary.toLowerCase() === 'none' || item.diets.includes(input.dietary.toLowerCase()))).sort((a, b) => {
                const score = (item: Activity) => interestsScore(item.tags, input.interests) * 10 + Number(item.bestTime.toLowerCase() === slot) * 5 + Number(forecast.rainy && item.indoor) * 3;
                return score(b) - score(a);
              })[0];
              if (!activity) continue;
              used.add(activity.id);
              if (activity.category === 'food') foodStops++;
              cost += activity.cost;
            }
          });
          return cost;
        };
        const paceCount = input.pace === 'slow' ? 2 : input.pace === 'balanced' ? 3 : 4;
        const used = new Set<string>();
        let activitiesTotal = 0;
        const days = dates.map((date, dayIndex) => {
          const forecast = weather[dayIndex];
          const slots = ['morning', 'afternoon', 'evening', 'late'];
          const items: Itinerary['days'][number]['items'] = [];
          let foodStops = 0;
          for (const slot of slots.slice(0, paceCount)) {
            const candidates = pool.filter((activity) => !used.has(activity.id) && (activity.category !== 'food' || foodStops === 0) && (activity.category !== 'food' || input.dietary.toLowerCase() === 'none' || activity.diets.includes(input.dietary.toLowerCase()))).sort((a, b) => {
              const score = (activity: typeof a) => interestsScore(activity.tags, input.interests) * 10 + Number(activity.bestTime.toLowerCase() === slot) * 5 + Number(forecast.rainy && activity.indoor) * 3;
              return score(b) - score(a);
            });
            const activity = candidates[0];
            if (!activity) {
              items.push({ slot, activityId: 'free-time', name: 'Free time', category: 'free_time', cost: 0, durationHours: 0, indoor: forecast.rainy, note: 'Activity pool exhausted; unstructured time has no activity cost.' });
              continue;
            }
            used.add(activity.id);
            if (activity.category === 'food') foodStops++;
            activitiesTotal += activity.cost;
            items.push({ slot, activityId: activity.id, name: activity.name, category: activity.category, cost: activity.cost, durationHours: activity.durationHours, indoor: activity.indoor, note: `${activity.bestTime === slot ? 'Best time of day.' : 'Flexible timing.'}${forecast.rainy && activity.indoor ? ' Indoor choice for rainy weather.' : ''}` });
          }
          return { date, weather: forecast, items, dayCost: items.reduce((sum, item) => sum + item.cost, 0) + cities[cityName].allowance };
        });
        const nights = nightsBetween(input.startDate, input.endDate);
        const lodgingTotal = lodge.nightlyRate * nights;
        const localAllowance = cities[cityName].allowance * dates.length;
        const estimated = flight.price + lodgingTotal + activitiesTotal + localAllowance;
        if (estimated > input.budget) {
          const cheapestFlight = flights[cityName][0];
          const cheapestLodging = lodgings[cityName][0];
          const paceOrder = ['full', 'balanced', 'slow'] as const;
          const requestedPaceIndex = paceOrder.indexOf(input.pace);
          const suggestions = paceOrder.slice(requestedPaceIndex).map((pace) => ({
            pace,
            flightId: cheapestFlight.id,
            lodgingId: cheapestLodging.id,
            estimated: cheapestFlight.price + cheapestLodging.nightlyRate * nights + activityCostForPace(pace) + localAllowance,
          })).filter((suggestion) => suggestion.estimated <= input.budget);
          const bestSuggestion = suggestions[0];
          const message = bestSuggestion
            ? `Estimated €${estimated} exceeds budget €${input.budget}. Try pace=${bestSuggestion.pace} with flightId=${bestSuggestion.flightId} and lodgingId=${bestSuggestion.lodgingId} (estimated €${bestSuggestion.estimated}).`
            : `Estimated €${estimated} exceeds budget €${input.budget}. Even the cheapest options exceed the budget; call ask_clarification and ask the user to raise the budget or shorten the trip.`;
          const minimumPossible = cheapestFlight.price + cheapestLodging.nightlyRate * nights + localAllowance;
          throw Object.assign(new Error(message), { errorType: 'over_budget', details: { estimated, budget: input.budget, overage: estimated - input.budget, breakdown: { flight: flight.price, lodging: lodgingTotal, activities: activitiesTotal, localAllowance }, minimumPossible, suggestions } });
        }
        const plan = ItinerarySchema.parse({
          destination: cityName, startDate: input.startDate, endDate: input.endDate, currency: 'EUR',
          flight: { id: flight.id, airline: flight.airline, price: flight.price },
          lodging: { id: lodge.id, name: lodge.name, neighborhood: lodge.neighborhood, nightlyRate: lodge.nightlyRate, nights, total: lodgingTotal },
          days, totals: { flight: flight.price, lodging: lodgingTotal, activities: activitiesTotal, localAllowance, estimated, budget: input.budget, remaining: input.budget - estimated },
          notes: ['One traveller; all estimates are in EUR.', 'Free-time items cost €0 and are excluded from activity spend.', 'Activity times are suggested slots; arrival and departure times are not modeled.'], summary: '', tips: [],
        });
        const planId = `plan-${++planCounter}`;
        plans.set(planId, plan);
        return { planId, preview: { destination: cityName, estimated, budget: input.budget } };
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
