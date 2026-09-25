import type {
  PluginConversationEventCostDay,
  PluginConversationEventStats,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { juniorConversationEvents } from "@/db/schema";

const DAY_MS = 24 * 60 * 60 * 1_000;

const costRowSchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/),
    events: z.number().int().nonnegative(),
  })
  .strict();

function startOfUtcDay(value: number): Date {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function registeredEventName(
  plugin: PluginRegistration,
  eventName: string,
): string {
  if (
    !plugin.conversationEvents?.some(
      (definition) => definition.eventName === eventName,
    )
  ) {
    throw new TypeError(
      `Plugin "${plugin.manifest.name}" did not register event "${eventName}"`,
    );
  }
  return eventName;
}

/** Create aggregate event-cost reads bound to one plugin's registered namespace. */
export function createPluginConversationEventStats(
  plugin: PluginRegistration,
  now: () => number = Date.now,
): PluginConversationEventStats {
  return {
    async costsByHour(input) {
      const eventName = registeredEventName(plugin, input.eventName);
      const hourCount = input.hours ?? 24;
      const end = new Date(now());
      end.setUTCMinutes(0, 0, 0);
      const start = new Date(end.getTime() - (hourCount - 1) * 60 * 60 * 1_000);
      const endExclusive = new Date(end.getTime() + 60 * 60 * 1_000);
      const date = sql<string>`TO_CHAR(
        ${juniorConversationEvents.createdAt} AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24'
      )`;
      const cost = sql<number>`CASE
        WHEN jsonb_typeof(${juniorConversationEvents.payload}->'content'->'costUsd') = 'number'
          THEN (${juniorConversationEvents.payload}->'content'->>'costUsd')::double precision
        ELSE 0
      END`;
      const rows = await getDb()
        .select({
          costUsd: sql<number>`SUM(${cost})::double precision`.mapWith(Number),
          date,
          events: sql<number>`COUNT(*)::integer`.mapWith(Number),
        })
        .from(juniorConversationEvents)
        .where(
          and(
            eq(juniorConversationEvents.type, "structured_event"),
            sql`${juniorConversationEvents.payload}->>'namespace' = ${plugin.manifest.name}`,
            sql`${juniorConversationEvents.payload}->>'name' = ${eventName}`,
            gte(juniorConversationEvents.createdAt, start),
            lt(juniorConversationEvents.createdAt, endExclusive),
          ),
        )
        .groupBy(date);
      const byHour = new Map(
        z
          .array(costRowSchema)
          .parse(rows)
          .map((row) => [row.date, row]),
      );
      return Array.from({ length: hourCount }, (_, index) => {
        const hour = new Date(start.getTime() + index * 60 * 60 * 1_000);
        const key = hour.toISOString().slice(0, 13);
        return (
          byHour.get(key) ??
          ({
            costUsd: 0,
            date: key,
            events: 0,
          } satisfies PluginConversationEventCostDay)
        );
      });
    },
    async costsByDay(input) {
      const eventName = registeredEventName(plugin, input.eventName);
      const end = startOfUtcDay(now());
      const start = new Date(end.getTime() - (input.days - 1) * DAY_MS);
      const endExclusive = new Date(end.getTime() + DAY_MS);
      const date = sql<string>`TO_CHAR(
        ${juniorConversationEvents.createdAt} AT TIME ZONE 'UTC',
        'YYYY-MM-DD'
      )`;
      const cost = sql<number>`CASE
        WHEN jsonb_typeof(${juniorConversationEvents.payload}->'content'->'costUsd') = 'number'
          THEN (${juniorConversationEvents.payload}->'content'->>'costUsd')::double precision
        ELSE 0
      END`;
      const rows = await getDb()
        .select({
          costUsd: sql<number>`SUM(${cost})::double precision`.mapWith(Number),
          date,
          events: sql<number>`COUNT(*)::integer`.mapWith(Number),
        })
        .from(juniorConversationEvents)
        .where(
          and(
            eq(juniorConversationEvents.type, "structured_event"),
            sql`${juniorConversationEvents.payload}->>'namespace' = ${plugin.manifest.name}`,
            sql`${juniorConversationEvents.payload}->>'name' = ${eventName}`,
            gte(juniorConversationEvents.createdAt, start),
            lt(juniorConversationEvents.createdAt, endExclusive),
          ),
        )
        .groupBy(date);
      const byDate = new Map(
        z
          .array(costRowSchema)
          .parse(rows)
          .map((row) => [row.date, row]),
      );
      return Array.from({ length: input.days }, (_, index) => {
        const day = new Date(start.getTime() + index * DAY_MS);
        const date = day.toISOString().slice(0, 10);
        return (
          byDate.get(date) ??
          ({
            costUsd: 0,
            date,
            events: 0,
          } satisfies PluginConversationEventCostDay)
        );
      });
    },
  };
}
