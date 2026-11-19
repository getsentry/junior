import * as z from "zod";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { StateAdapter } from "chat";
import { cacheKeyPrefix } from "@/chat/state/cache";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";

const HOUR_MS = 60 * 60 * 1_000;
const STATE_KEY = `${cacheKeyPrefix("core")}conversation-stats:guardian-hours`;
// A review that commits after a read can have an earlier `created_at`, and
// app and database clocks can differ. Each read starts this long before the
// previous one, at the start of that hour, and reads those hours again.
const LATE_COMMIT_MS = 5 * 60_000;

const guardianHourSchema = z
  .object({
    allow: z.number(),
    ask: z.number(),
    costUsd: z.number().nullable(),
    date: z.string(),
    deny: z.number(),
    requests: z.number(),
  })
  .strict();

const storedHoursSchema = z
  .object({
    hours: z.array(guardianHourSchema),
    throughMs: z.number(),
  })
  .strict();

type GuardianHour = z.infer<typeof guardianHourSchema>;

function hourKey(instant: Date): string {
  return instant.toISOString().slice(0, 13);
}

/**
 * Read Guardian review counts per UTC hour. The hours of the previous read
 * stay in state, so a read only reads the reviews after it, plus the overlap
 * for late commits. Without stored hours it reads the whole window.
 */
export async function readGuardianHours(
  db: JuniorDatabase,
  state: StateAdapter,
  window: { start: Date; end: Date },
): Promise<GuardianHour[]> {
  await state.connect();
  const stored = storedHoursSchema.safeParse(await state.get(STATE_KEY));
  const previous =
    stored.success && stored.data.throughMs <= window.end.getTime()
      ? stored.data
      : undefined;
  const from = previous
    ? new Date(
        Math.max(
          window.start.getTime(),
          Math.floor((previous.throughMs - LATE_COMMIT_MS) / HOUR_MS) * HOUR_MS,
        ),
      )
    : window.start;
  const startHour = hourKey(window.start);
  const fromHour = hourKey(from);
  const kept = (previous?.hours ?? []).filter(
    (hour) => hour.date >= startHour && hour.date < fromHour,
  );
  const read = await readGuardianHoursFromSql(db, from, window.end);
  const hours = [...kept, ...read].sort((left, right) =>
    left.date < right.date ? -1 : 1,
  );
  // Hours older than the window are dropped at the next read, so the entry
  // never needs to outlive the window.
  await state.set(
    STATE_KEY,
    { hours, throughMs: window.end.getTime() },
    window.end.getTime() - window.start.getTime() + HOUR_MS,
  );
  return hours;
}

async function readGuardianHoursFromSql(
  db: JuniorDatabase,
  start: Date,
  end: Date,
): Promise<GuardianHour[]> {
  const events = juniorConversationEvents;
  const hour = sql<string>`TO_CHAR(
    ${events.createdAt} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24'
  )`;
  const decision = sql`${events.payload}->>'decision'`;
  const cost = sql<number | null>`CASE
    WHEN jsonb_typeof(${events.payload}->'costUsd') = 'number'
      THEN (${events.payload}->>'costUsd')::double precision
    ELSE NULL
  END`;
  return await db
    .select({
      allow: sql<number>`COUNT(*) FILTER (WHERE ${decision} = 'allow')::integer`,
      ask: sql<number>`COUNT(*) FILTER (WHERE ${decision} = 'ask')::integer`,
      costUsd: sql<number | null>`SUM(${cost})::double precision`,
      date: hour,
      deny: sql<number>`COUNT(*) FILTER (WHERE ${decision} = 'deny')::integer`,
      requests: sql<number>`COUNT(*)::integer`,
    })
    .from(events)
    .where(
      and(
        eq(events.type, "guardian_action_reviewed"),
        gte(events.createdAt, start),
        lte(events.createdAt, end),
      ),
    )
    .groupBy(hour);
}
