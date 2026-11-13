import {
  isPluginModelCostEventName,
  type PluginConversationEventCostDay,
  type PluginConversationEventStats,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import * as z from "zod";
import { getDb } from "@/chat/db";
import {
  getStateAdapter,
  getStateValues,
  setStateValues,
} from "@/chat/state/adapter";
import { juniorConversationEvents } from "@/db/schema";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const costRowSchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/),
    events: z.number().int().nonnegative(),
  })
  .strict();

const cachedBucketSchema = costRowSchema.omit({ date: true });

type BucketUnit = {
  ms: number;
  /** `TO_CHAR` format whose output equals `keyLength` ISO characters. */
  sqlFormat: string;
  keyLength: number;
};

const DAY: BucketUnit = { ms: DAY_MS, sqlFormat: "YYYY-MM-DD", keyLength: 10 };
const HOUR: BucketUnit = {
  ms: HOUR_MS,
  sqlFormat: 'YYYY-MM-DD"T"HH24',
  keyLength: 13,
};

// The cost of each event is in its JSON payload, so a read fetches one heap
// row for each event in the window, and Postgres cannot read it from an
// index. A 90-day window then outlasts the statement timeout. A past bucket
// does not change: a plugin event records the time of its append, and a fork
// does not copy plugin events. So a read caches each settled bucket and
// queries only the buckets after the cached ones.
//
// An append can commit a little after the time that it records, so a bucket
// settles this long after it ends.
const BUCKET_SETTLE_MS = 5 * 60 * 1_000;
// Longer than the largest daily window, 90 days.
const BUCKET_CACHE_TTL_MS = 91 * DAY_MS;

function bucketCacheKey(
  namespace: string,
  eventName: string,
  bucket: string,
): string {
  return `plugin-event-costs:v1:${namespace}:${eventName}:${bucket}`;
}

async function queryCostBuckets(args: {
  end: Date;
  eventName: string;
  namespace: string;
  start: Date;
  unit: BucketUnit;
}): Promise<Map<string, z.output<typeof costRowSchema>>> {
  const date = sql<string>`TO_CHAR(
    ${juniorConversationEvents.createdAt} AT TIME ZONE 'UTC',
    ${sql.raw(`'${args.unit.sqlFormat}'`)}
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
        sql`${juniorConversationEvents.payload}->>'namespace' = ${args.namespace}`,
        sql`${juniorConversationEvents.payload}->>'name' = ${args.eventName}`,
        gte(juniorConversationEvents.createdAt, args.start),
        lt(juniorConversationEvents.createdAt, args.end),
      ),
    )
    .groupBy(date);
  return new Map(
    z
      .array(costRowSchema)
      .parse(rows)
      .map((row) => [row.date, row]),
  );
}

async function readCostBuckets(args: {
  count: number;
  eventName: string;
  namespace: string;
  nowMs: number;
  start: Date;
  unit: BucketUnit;
}): Promise<PluginConversationEventCostDay[]> {
  const { count, eventName, namespace, unit } = args;
  const startMs = args.start.getTime();
  const buckets = Array.from({ length: count }, (_, index) =>
    new Date(startMs + index * unit.ms).toISOString().slice(0, unit.keyLength),
  );
  const settledCount = Math.min(
    count,
    Math.max(
      0,
      Math.floor((args.nowMs - BUCKET_SETTLE_MS - startMs) / unit.ms),
    ),
  );
  const state = getStateAdapter();
  const cached = (
    await getStateValues(
      state,
      buckets
        .slice(0, settledCount)
        .map((bucket) => bucketCacheKey(namespace, eventName, bucket)),
    )
  ).map((value) => cachedBucketSchema.safeParse(value).data);
  const firstMissing = cached.findIndex((value) => value === undefined);
  const queryFrom = firstMissing === -1 ? settledCount : firstMissing;

  const queried =
    queryFrom < count
      ? await queryCostBuckets({
          end: new Date(startMs + count * unit.ms),
          eventName,
          namespace,
          start: new Date(startMs + queryFrom * unit.ms),
          unit,
        })
      : new Map<string, z.output<typeof costRowSchema>>();
  const result = buckets.map((date, index) => {
    const value = index < queryFrom ? cached[index] : queried.get(date);
    return {
      costUsd: value?.costUsd ?? 0,
      date,
      events: value?.events ?? 0,
    } satisfies PluginConversationEventCostDay;
  });
  await setStateValues(
    state,
    result.slice(queryFrom, settledCount).map(({ date, ...value }) => ({
      key: bucketCacheKey(namespace, eventName, date),
      value,
    })),
    BUCKET_CACHE_TTL_MS,
  );
  return result;
}

// A plugin reads its registered events and the host-written cost events of
// its model calls.
function registeredEventName(
  plugin: PluginRegistration,
  eventName: string,
): string {
  if (
    !isPluginModelCostEventName(eventName) &&
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

/** Read daily cost buckets of one structured event, newest day last. */
export async function readConversationEventCostsByDay(args: {
  days: number;
  eventName: string;
  namespace: string;
  nowMs: number;
}): Promise<PluginConversationEventCostDay[]> {
  const end = new Date(args.nowMs);
  end.setUTCHours(0, 0, 0, 0);
  return await readCostBuckets({
    count: args.days,
    eventName: args.eventName,
    namespace: args.namespace,
    nowMs: args.nowMs,
    start: new Date(end.getTime() - (args.days - 1) * DAY_MS),
    unit: DAY,
  });
}

/** Create aggregate event-cost reads bound to one plugin's registered namespace. */
export function createPluginConversationEventStats(
  plugin: PluginRegistration,
  now: () => number = Date.now,
): PluginConversationEventStats {
  return {
    async costsByHour(input) {
      const nowMs = now();
      const count = input.hours ?? 24;
      const end = new Date(nowMs);
      end.setUTCMinutes(0, 0, 0);
      return await readCostBuckets({
        count,
        eventName: registeredEventName(plugin, input.eventName),
        namespace: plugin.manifest.name,
        nowMs,
        start: new Date(end.getTime() - (count - 1) * HOUR_MS),
        unit: HOUR,
      });
    },
    async costsByDay(input) {
      return await readConversationEventCostsByDay({
        days: input.days,
        eventName: registeredEventName(plugin, input.eventName),
        namespace: plugin.manifest.name,
        nowMs: now(),
      });
    },
  };
}
