import { z } from 'zod';
import { dateSchema } from './dates.js';

export const TravelRequestSchema = z.object({
  origin: z.string().default('PRG'), destination: z.string().min(1), startDate: dateSchema, endDate: dateSchema,
  budget: z.number().positive(), preferences: z.object({ pace: z.enum(['slow', 'balanced', 'full']), interests: z.array(z.string()), dietary: z.string().default('none') }),
}).superRefine((request, ctx) => {
  if (request.endDate < request.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be on or after start date' });
  const start = new Date(`${request.startDate}T00:00:00Z`).valueOf();
  const end = new Date(`${request.endDate}T00:00:00Z`).valueOf();
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days < 2 || days > 7) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Trips must span 2-7 calendar days' });
});
export type TravelRequest = z.infer<typeof TravelRequestSchema>;

export const ItinerarySchema = z.object({
  destination: z.string(), startDate: dateSchema, endDate: dateSchema, currency: z.literal('EUR'),
  flight: z.object({ id: z.string(), airline: z.string(), price: z.number().nonnegative() }),
  lodging: z.object({ id: z.string(), name: z.string(), neighborhood: z.string(), nightlyRate: z.number().nonnegative(), nights: z.number().int().nonnegative(), total: z.number().nonnegative() }),
  days: z.array(z.object({ date: dateSchema, weather: z.object({ condition: z.string(), high: z.number(), low: z.number(), rainChance: z.number(), rainy: z.boolean() }), items: z.array(z.object({ slot: z.string(), activityId: z.string(), name: z.string(), category: z.string(), cost: z.number().nonnegative(), durationHours: z.number().nonnegative(), indoor: z.boolean(), note: z.string() })), dayCost: z.number().nonnegative() })),
  totals: z.object({ flight: z.number(), lodging: z.number(), activities: z.number(), localAllowance: z.number(), estimated: z.number(), budget: z.number(), remaining: z.number() }),
  notes: z.array(z.string()), summary: z.string(), tips: z.array(z.string()),
});
export type Itinerary = z.infer<typeof ItinerarySchema>;

export const ToolResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), data: z.unknown() }),
  z.object({ status: z.literal('error'), errorType: z.enum(['bad_input', 'no_results', 'over_budget', 'internal']), message: z.string(), details: z.unknown().optional() }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;
