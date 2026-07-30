/**
 * SQL operations over personal memories owned by one authenticated viewer.
 *
 * A viewer may resolve to several runtime actors. This store combines their
 * personal scopes without treating one actor as the canonical identity.
 */
import { and, asc, desc, eq, gt, ilike, like, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import { deriveMemoryScope, type ResolvedMemoryScope } from "./scope";
import {
  activeVisiblePredicate,
  archiveExpiredMemoryBatch,
  parseMemoryRow,
  type MemoryDb,
  type MemoryRecord,
} from "./store";
import { MEMORY_KINDS, type MemoryRuntimeContext } from "./types";

const nonEmptyStringSchema = z.string().min(1);
const personalMemoryCursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: nonEmptyStringSchema,
  })
  .strict();
const personalMemoryPageInputSchema = z
  .object({
    cursor: personalMemoryCursorSchema.optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    limit: z.number().int().min(1).max(50),
    origin: z.enum(["automatic", "explicit"]).optional(),
    query: z.string().max(200).optional(),
  })
  .strict();
const personalMemoryTimelineInputSchema = z
  .object({
    days: z.number().int().min(1).max(365),
  })
  .strict();
const DAY_MS = 24 * 60 * 60 * 1_000;

export type PersonalMemoryCursor = z.output<typeof personalMemoryCursorSchema>;

export type PersonalMemoryPageInput = z.output<
  typeof personalMemoryPageInputSchema
>;

export interface PersonalMemoryPage {
  memories: PersonalMemoryRecord[];
  nextCursor?: PersonalMemoryCursor;
}

/** Safe provenance attached to one viewer-owned personal memory. */
export type PersonalMemoryRecord = MemoryRecord & {
  origin: "automatic" | "explicit" | "other";
  sourcePlatform: "local" | "slack";
};

/** Viewer-scoped active memory totals used by the dashboard. */
export interface PersonalMemoryStats {
  active: number;
  automatic: number;
  createdThirtyDays: number;
  embedded: number;
  explicit: number;
  knowledge: number;
  preference: number;
  procedure: number;
}

/** Viewer-scoped memory creation totals for one UTC calendar day. */
export interface PersonalMemoryDay {
  date: string;
  knowledge: number;
  preference: number;
  procedure: number;
}

/** Expected failure when a viewer does not own the requested memory. */
export class PersonalMemoryNotFoundError extends Error {
  constructor() {
    super("Memory was not found for the authenticated viewer.");
    this.name = "PersonalMemoryNotFoundError";
  }
}

/** Viewer-scoped personal memory operations shared by dashboard and REST. */
export interface PersonalMemoryCollection {
  /** Archive one exact personal memory owned by a linked actor. */
  archive(id: string): Promise<MemoryRecord>;
  /** Read one exact personal memory owned by a linked actor. */
  get(id: string): Promise<MemoryRecord>;
  /** List one stable page across every linked personal scope. */
  list(input: PersonalMemoryPageInput): Promise<PersonalMemoryPage>;
  /** Summarize active memories across every linked personal scope. */
  stats(): Promise<PersonalMemoryStats>;
  /** Read memory creation history across every linked personal scope. */
  timeline(input: { days: number }): Promise<PersonalMemoryDay[]>;
}

function personalScopes(
  runtimeContexts: MemoryRuntimeContext[],
): ResolvedMemoryScope[] {
  return [
    ...new Map(
      runtimeContexts.map((context) => {
        const scope = deriveMemoryScope(context, "personal");
        return [`${scope.scope}:${scope.scopeKey}`, scope] as const;
      }),
    ).values(),
  ];
}

function personalScopePredicate(scopes: ResolvedMemoryScope[]) {
  if (scopes.length === 0) return undefined;
  return or(
    ...scopes.map((scope) =>
      and(
        eq(juniorMemoryMemories.scope, scope.scope),
        eq(juniorMemoryMemories.scopeKey, scope.scopeKey),
      ),
    ),
  );
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_'-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  ];
}

function memoryOrigin(
  idempotencyKey: string | null,
): PersonalMemoryRecord["origin"] {
  if (idempotencyKey?.startsWith("session:")) return "automatic";
  if (idempotencyKey?.startsWith("tool:")) return "explicit";
  return "other";
}

function personalMemoryRecord(
  row: typeof juniorMemoryMemories.$inferSelect,
): PersonalMemoryRecord {
  return {
    ...parseMemoryRow(row),
    origin: memoryOrigin(row.idempotencyKey),
    sourcePlatform: row.sourcePlatform,
  };
}

/** Build storage operations for every personal scope linked to one viewer. */
export function createPersonalMemoryCollection(
  db: MemoryDb,
  runtimeContexts: MemoryRuntimeContext[],
  options: { now?: () => number } = {},
): PersonalMemoryCollection {
  const scopes = personalScopes(runtimeContexts);
  const getNowMs = () => options.now?.() ?? Date.now();

  return {
    async archive(id) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = getNowMs();
      const predicate = activeVisiblePredicate({ nowMs, scopes });
      if (!predicate) {
        throw new PersonalMemoryNotFoundError();
      }
      const updated = await db
        .update(juniorMemoryMemories)
        .set({
          archivedAtMs: nowMs,
          archiveReason: "user_removed",
        })
        .where(and(predicate, eq(juniorMemoryMemories.id, memoryId)))
        .returning();
      if (!updated[0]) {
        throw new PersonalMemoryNotFoundError();
      }
      await db
        .delete(juniorMemoryEmbeddings)
        .where(eq(juniorMemoryEmbeddings.memoryId, memoryId));
      return parseMemoryRow(updated[0]);
    },

    async get(id) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = getNowMs();
      const predicate = activeVisiblePredicate({ nowMs, scopes });
      if (!predicate) {
        throw new PersonalMemoryNotFoundError();
      }
      const rows = await db
        .select()
        .from(juniorMemoryMemories)
        .where(and(predicate, eq(juniorMemoryMemories.id, memoryId)))
        .limit(1);
      if (!rows[0]) {
        throw new PersonalMemoryNotFoundError();
      }
      return parseMemoryRow(rows[0]);
    },

    async list(input) {
      input = personalMemoryPageInputSchema.parse(input);
      const nowMs = getNowMs();
      await archiveExpiredMemoryBatch({ db, nowMs, scopes });
      const active = activeVisiblePredicate({ nowMs, scopes });
      if (!active) {
        return { memories: [] };
      }

      const cursor = input.cursor
        ? or(
            lt(juniorMemoryMemories.createdAtMs, input.cursor.createdAtMs),
            and(
              eq(juniorMemoryMemories.createdAtMs, input.cursor.createdAtMs),
              gt(juniorMemoryMemories.id, input.cursor.id),
            ),
          )
        : undefined;
      const terms = input.query ? searchTerms(input.query) : [];
      const search =
        input.query === undefined
          ? undefined
          : terms.length === 0
            ? sql`false`
            : or(
                ...terms.map((term) =>
                  ilike(juniorMemoryMemories.content, `%${term}%`),
                ),
              );
      const kind = input.kind
        ? eq(juniorMemoryMemories.kind, input.kind)
        : undefined;
      const origin =
        input.origin === "automatic"
          ? like(juniorMemoryMemories.idempotencyKey, "session:%")
          : input.origin === "explicit"
            ? like(juniorMemoryMemories.idempotencyKey, "tool:%")
            : undefined;
      const rows = await db
        .select()
        .from(juniorMemoryMemories)
        .where(and(active, cursor, search, kind, origin))
        .orderBy(
          desc(juniorMemoryMemories.createdAtMs),
          asc(juniorMemoryMemories.id),
        )
        .limit(input.limit + 1);
      const hasNextPage = rows.length > input.limit;
      const memories = rows.slice(0, input.limit).map(personalMemoryRecord);
      const last = memories.at(-1);
      return {
        memories,
        ...(hasNextPage && last
          ? {
              nextCursor: {
                createdAtMs: last.createdAtMs,
                id: last.id,
              },
            }
          : {}),
      };
    },

    async stats() {
      const nowMs = getNowMs();
      await archiveExpiredMemoryBatch({ db, nowMs, scopes });
      const active = activeVisiblePredicate({ nowMs, scopes });
      if (!active) {
        return {
          active: 0,
          automatic: 0,
          createdThirtyDays: 0,
          embedded: 0,
          explicit: 0,
          knowledge: 0,
          preference: 0,
          procedure: 0,
        };
      }
      const [counts] = await db
        .select({
          active: sql<number>`count(*)`.mapWith(Number),
          automatic:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.idempotencyKey} like 'session:%')`.mapWith(
              Number,
            ),
          createdThirtyDays:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.createdAtMs} >= ${nowMs - 30 * 24 * 60 * 60 * 1_000})`.mapWith(
              Number,
            ),
          embedded:
            sql<number>`count(${juniorMemoryEmbeddings.memoryId})`.mapWith(
              Number,
            ),
          explicit:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.idempotencyKey} like 'tool:%')`.mapWith(
              Number,
            ),
          knowledge:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.kind} = 'knowledge')`.mapWith(
              Number,
            ),
          preference:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.kind} = 'preference')`.mapWith(
              Number,
            ),
          procedure:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.kind} = 'procedure')`.mapWith(
              Number,
            ),
        })
        .from(juniorMemoryMemories)
        .leftJoin(
          juniorMemoryEmbeddings,
          eq(juniorMemoryEmbeddings.memoryId, juniorMemoryMemories.id),
        )
        .where(active);
      return {
        active: counts?.active ?? 0,
        automatic: counts?.automatic ?? 0,
        createdThirtyDays: counts?.createdThirtyDays ?? 0,
        embedded: counts?.embedded ?? 0,
        explicit: counts?.explicit ?? 0,
        knowledge: counts?.knowledge ?? 0,
        preference: counts?.preference ?? 0,
        procedure: counts?.procedure ?? 0,
      };
    },

    async timeline(input) {
      input = personalMemoryTimelineInputSchema.parse(input);
      const todayMs = Date.parse(`${utcDate(getNowMs())}T00:00:00.000Z`);
      const startMs = todayMs - (input.days - 1) * DAY_MS;
      const ownership = personalScopePredicate(scopes);
      if (!ownership) {
        return Array.from({ length: input.days }, (_, index) => ({
          date: utcDate(startMs + index * DAY_MS),
          knowledge: 0,
          preference: 0,
          procedure: 0,
        }));
      }
      const rows = await db
        .select({
          date: sql<string>`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
            "date",
          ),
          knowledge:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.kind} = 'knowledge')`.mapWith(
              Number,
            ),
          preference:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.kind} = 'preference')`.mapWith(
              Number,
            ),
          procedure:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.kind} = 'procedure')`.mapWith(
              Number,
            ),
        })
        .from(juniorMemoryMemories)
        .where(
          and(ownership, gt(juniorMemoryMemories.createdAtMs, startMs - 1)),
        )
        .groupBy(
          sql`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        );
      const byDate = new Map(rows.map((row) => [row.date, row]));
      return Array.from({ length: input.days }, (_, index) => {
        const date = utcDate(startMs + index * DAY_MS);
        const row = byDate.get(date);
        return {
          date,
          knowledge: row?.knowledge ?? 0,
          preference: row?.preference ?? 0,
          procedure: row?.procedure ?? 0,
        };
      });
    },
  };
}
