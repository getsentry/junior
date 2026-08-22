/**
 * Memory reads for an authenticated User.
 *
 * Every User can read public memory and private memory that they own.
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  like,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import { publicMemoryScope } from "./scope";
import { parseMemoryRow, type MemoryDb, type MemoryRecord } from "./store";
import { MEMORY_KINDS, type MemorySourcePlatform } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const nonEmptyStringSchema = z.string().min(1);
const memoryVisibilitySchema = z.enum(["private", "public"]);
const cursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: nonEmptyStringSchema,
    kind: z.enum(MEMORY_KINDS).optional(),
    origin: z.enum(["automatic", "explicit"]).optional(),
    query: z.string().max(200).optional(),
    version: z.literal(1),
    visibility: memoryVisibilitySchema.optional(),
  })
  .strict();
const pageInputSchema = z
  .object({
    cursor: z.string().min(1).max(1_000).optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    limit: z.number().int().min(1).max(50),
    origin: z.enum(["automatic", "explicit"]).optional(),
    query: z.string().max(200).optional(),
    visibility: memoryVisibilitySchema.optional(),
  })
  .strict();
const timelineInputSchema = z
  .object({
    days: z.number().int().min(1).max(365),
  })
  .strict();

/** Access label returned by dashboard and REST memory views. */
export type MemoryVisibility = z.output<typeof memoryVisibilitySchema>;

/** Memory fields returned to an authenticated User. */
export type ViewerMemory = MemoryRecord & {
  origin: "automatic" | "explicit" | "other";
  sourcePlatform: MemorySourcePlatform;
  visibility: MemoryVisibility;
};

interface MemoryPage {
  memories: ViewerMemory[];
  nextCursor?: string;
}

type MemoryPageInput = z.output<typeof pageInputSchema>;

/** Expected error for a malformed or mismatched page cursor. */
export class InvalidMemoryCursorError extends Error {
  constructor() {
    super("Memory cursor is invalid.");
    this.name = "InvalidMemoryCursorError";
  }
}

/** Expected error when the current User cannot access a memory. */
export class MemoryNotFoundError extends Error {
  constructor() {
    super("Memory was not found for this user.");
    this.name = "MemoryNotFoundError";
  }
}

function publicScopePredicate() {
  return and(
    eq(juniorMemoryMemories.scope, publicMemoryScope.scope),
    eq(juniorMemoryMemories.scopeKey, publicMemoryScope.scopeKey),
  );
}

function privateScopePredicate(userId: string) {
  return and(
    eq(juniorMemoryMemories.scope, "private"),
    eq(juniorMemoryMemories.scopeKey, userId),
  );
}

function visibleScopePredicate(userId: string, visibility?: MemoryVisibility) {
  if (visibility === "public") return publicScopePredicate();
  if (visibility === "private") return privateScopePredicate(userId);
  return or(publicScopePredicate(), privateScopePredicate(userId));
}

function activeMemoryPredicate(
  userId: string,
  nowMs: number,
  visibility?: MemoryVisibility,
) {
  return and(
    visibleScopePredicate(userId, visibility),
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, nowMs),
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

function memoryOrigin(idempotencyKey: string | null): ViewerMemory["origin"] {
  if (idempotencyKey?.startsWith("session:")) return "automatic";
  if (idempotencyKey?.startsWith("tool:")) return "explicit";
  return "other";
}

function toViewerMemory(
  row: typeof juniorMemoryMemories.$inferSelect,
): ViewerMemory {
  const memory = parseMemoryRow(row);
  return {
    ...memory,
    origin: memoryOrigin(row.idempotencyKey),
    sourcePlatform: row.sourcePlatform,
    visibility: memory.scope,
  };
}

function cursorFilters(input: MemoryPageInput) {
  const query = input.query?.trim() || undefined;
  return {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(query ? { query } : {}),
    ...(input.visibility ? { visibility: input.visibility } : {}),
  };
}

function decodeCursor(
  value: string | undefined,
  filters: ReturnType<typeof cursorFilters>,
) {
  if (!value) return undefined;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      parsed.query !== filters.query ||
      parsed.kind !== filters.kind ||
      parsed.origin !== filters.origin ||
      parsed.visibility !== filters.visibility
    ) {
      throw new InvalidMemoryCursorError();
    }
    return { createdAtMs: parsed.createdAtMs, id: parsed.id };
  } catch {
    throw new InvalidMemoryCursorError();
  }
}

function encodeCursor(
  createdBefore: { createdAtMs: number; id: string },
  filters: ReturnType<typeof cursorFilters>,
): string {
  return Buffer.from(
    JSON.stringify({ ...createdBefore, ...filters, version: 1 }),
    "utf8",
  ).toString("base64url");
}

/** Build memory operations for one authenticated User. */
export function createViewerMemories(db: MemoryDb, user: { id: string }) {
  return {
    async archive(id: string) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = Date.now();
      const updated = await db
        .update(juniorMemoryMemories)
        .set({
          archivedAtMs: nowMs,
          archiveReason: "user_removed",
        })
        .where(
          and(
            activeMemoryPredicate(user.id, nowMs, "private"),
            eq(juniorMemoryMemories.id, memoryId),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new MemoryNotFoundError();
      }
      await db
        .delete(juniorMemoryEmbeddings)
        .where(eq(juniorMemoryEmbeddings.memoryId, memoryId));
      return parseMemoryRow(updated[0]);
    },

    async get(id: string) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = Date.now();
      const rows = await db
        .select()
        .from(juniorMemoryMemories)
        .where(
          and(
            activeMemoryPredicate(user.id, nowMs),
            eq(juniorMemoryMemories.id, memoryId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw new MemoryNotFoundError();
      }
      return toViewerMemory(rows[0]);
    },

    async list(input: MemoryPageInput): Promise<MemoryPage> {
      input = pageInputSchema.parse(input);
      const filters = cursorFilters(input);
      const cursor = decodeCursor(input.cursor, filters);
      const active = activeMemoryPredicate(
        user.id,
        Date.now(),
        input.visibility,
      );
      const createdBefore = cursor
        ? or(
            lt(juniorMemoryMemories.createdAtMs, cursor.createdAtMs),
            and(
              eq(juniorMemoryMemories.createdAtMs, cursor.createdAtMs),
              gt(juniorMemoryMemories.id, cursor.id),
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
        .where(and(active, createdBefore, search, kind, origin))
        .orderBy(
          desc(juniorMemoryMemories.createdAtMs),
          asc(juniorMemoryMemories.id),
        )
        .limit(input.limit + 1);
      const hasNextPage = rows.length > input.limit;
      const memories = rows.slice(0, input.limit).map(toViewerMemory);
      const last = memories.at(-1);
      return {
        memories,
        ...(hasNextPage && last
          ? {
              nextCursor: encodeCursor(
                { createdAtMs: last.createdAtMs, id: last.id },
                filters,
              ),
            }
          : {}),
      };
    },

    async stats() {
      const nowMs = Date.now();
      const active = activeMemoryPredicate(user.id, nowMs);
      const [counts] = await db
        .select({
          active: sql<number>`count(*)`.mapWith(Number),
          automatic:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.idempotencyKey} like 'session:%')`.mapWith(
              Number,
            ),
          createdThirtyDays:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.createdAtMs} >= ${nowMs - 30 * DAY_MS})`.mapWith(
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
          private:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.scope} = 'private')`.mapWith(
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
          public:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.scope} = 'public')`.mapWith(
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
        private: counts?.private ?? 0,
        preference: counts?.preference ?? 0,
        procedure: counts?.procedure ?? 0,
        public: counts?.public ?? 0,
      };
    },

    async timeline(input: { days: number }) {
      input = timelineInputSchema.parse(input);
      const todayMs = Date.parse(`${utcDate(Date.now())}T00:00:00.000Z`);
      const startMs = todayMs - (input.days - 1) * DAY_MS;
      const rows = await db
        .select({
          date: sql<string>`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
            "date",
          ),
          private:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.scope} = 'private')`.mapWith(
              Number,
            ),
          public:
            sql<number>`count(*) filter (where ${juniorMemoryMemories.scope} = 'public')`.mapWith(
              Number,
            ),
        })
        .from(juniorMemoryMemories)
        .where(
          and(
            visibleScopePredicate(user.id),
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
          private: row?.private ?? 0,
          public: row?.public ?? 0,
        };
      });
    },
  };
}
