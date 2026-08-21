/**
 * SQL operations over memories visible to one authenticated viewer.
 *
 * Authenticated viewer surfaces expose global public memory only. Private
 * memory stays inside the source domain that learned it.
 */
import { and, asc, desc, eq, gt, ilike, like, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import { publicMemoryScope } from "./scope";
import {
  activeVisiblePredicate,
  archiveExpiredMemoryBatch,
  parseMemoryRow,
  type MemoryDb,
  type MemoryRecord,
} from "./store";
import { MEMORY_KINDS, type MemorySourcePlatform } from "./types";

const nonEmptyStringSchema = z.string().min(1);
const viewerMemoryCursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: nonEmptyStringSchema,
  })
  .strict();
const viewerMemoryPageInputSchema = z
  .object({
    cursor: viewerMemoryCursorSchema.optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    limit: z.number().int().min(1).max(50),
    origin: z.enum(["automatic", "explicit"]).optional(),
    query: z.string().max(200).optional(),
  })
  .strict();
const viewerMemoryTimelineInputSchema = z
  .object({
    days: z.number().int().min(1).max(365),
  })
  .strict();
const DAY_MS = 24 * 60 * 60 * 1_000;

type ViewerMemoryCursor = z.output<typeof viewerMemoryCursorSchema>;

type ViewerMemoryPageInput = z.output<typeof viewerMemoryPageInputSchema>;

interface ViewerMemoryPage {
  memories: ViewerMemory[];
  nextCursor?: ViewerMemoryCursor;
}

/** Safe provenance attached to one viewer-visible memory. */
export type ViewerMemory = MemoryRecord & {
  origin: "automatic" | "explicit" | "other";
  sourcePlatform: MemorySourcePlatform;
};

/** Viewer-scoped active memory totals used by the dashboard. */
export interface ViewerMemoryStats {
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
export interface ViewerMemoryDay {
  date: string;
  memories: number;
}

/** Expected failure when a viewer cannot read the requested memory. */
export class ViewerMemoryNotFoundError extends Error {
  constructor() {
    super("Memory was not found for the authenticated viewer.");
    this.name = "ViewerMemoryNotFoundError";
  }
}

/** Viewer-scoped memory operations shared by dashboard and REST. */
interface ViewerMemoryCollection {
  /** Read one exact memory visible to the authorized scopes. */
  get(id: string): Promise<ViewerMemory>;
  /** List one stable page across every authorized viewer scope. */
  list(input: ViewerMemoryPageInput): Promise<ViewerMemoryPage>;
  /** Summarize active memories across every authorized viewer scope. */
  stats(): Promise<ViewerMemoryStats>;
  /** Read memory creation history across every authorized viewer scope. */
  timeline(input: { days: number }): Promise<ViewerMemoryDay[]>;
}

function publicScopePredicate() {
  return and(
    eq(juniorMemoryMemories.scope, publicMemoryScope.scope),
    eq(juniorMemoryMemories.scopeKey, publicMemoryScope.scopeKey),
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

function memoryOrigin(idempotencyKey: string | null): ViewerMemory["origin"] {
  if (idempotencyKey?.startsWith("session:")) return "automatic";
  if (idempotencyKey?.startsWith("tool:")) return "explicit";
  return "other";
}

function viewerMemory(
  row: typeof juniorMemoryMemories.$inferSelect,
): ViewerMemory {
  const memory = parseMemoryRow(row);
  return {
    ...memory,
    origin: memoryOrigin(row.idempotencyKey),
    sourcePlatform: row.sourcePlatform,
  };
}

function emptyStats(): ViewerMemoryStats {
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

/** Build public-memory storage operations for authenticated viewer surfaces. */
export function createViewerMemoryCollection(
  db: MemoryDb,
  options: { now?: () => number } = {},
): ViewerMemoryCollection {
  const scopes = [publicMemoryScope];
  const getNowMs = () => options.now?.() ?? Date.now();

  return {
    async get(id) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = getNowMs();
      const predicate = activeVisiblePredicate({ nowMs, scopes });
      if (!predicate) {
        throw new ViewerMemoryNotFoundError();
      }
      const rows = await db
        .select()
        .from(juniorMemoryMemories)
        .where(and(predicate, eq(juniorMemoryMemories.id, memoryId)))
        .limit(1);
      if (!rows[0]) {
        throw new ViewerMemoryNotFoundError();
      }
      return viewerMemory(rows[0]);
    },

    async list(input) {
      input = viewerMemoryPageInputSchema.parse(input);
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
      const memories = rows.slice(0, input.limit).map(viewerMemory);
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
          : undefined),
      };
    },

    async stats() {
      const nowMs = getNowMs();
      await archiveExpiredMemoryBatch({ db, nowMs, scopes });
      const active = activeVisiblePredicate({ nowMs, scopes });
      if (!active) {
        return emptyStats();
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
      input = viewerMemoryTimelineInputSchema.parse(input);
      const todayMs = Date.parse(`${utcDate(getNowMs())}T00:00:00.000Z`);
      const startMs = todayMs - (input.days - 1) * DAY_MS;
      const rows = await db
        .select({
          date: sql<string>`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
            "date",
          ),
          memories: sql<number>`count(*)`.mapWith(Number),
        })
        .from(juniorMemoryMemories)
        .where(
          and(
            publicScopePredicate(),
            gt(juniorMemoryMemories.createdAtMs, startMs - 1),
          ),
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
          memories: row?.memories ?? 0,
        };
      });
    },
  };
}
