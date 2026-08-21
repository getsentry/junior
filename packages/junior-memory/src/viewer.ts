/**
 * Memory access for an authenticated User.
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
import { parseMemoryRow, type MemoryDb, type Memory } from "./memories";
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
const timelineDaysSchema = z.number().int().min(1).max(365);

/** Access label returned by dashboard and REST memory views. */
export type MemoryVisibility = z.output<typeof memoryVisibilitySchema>;

/** Memory fields returned to an authenticated User. */
export type MemoryView = Memory & {
  origin: "automatic" | "explicit" | "other";
  sourcePlatform: MemorySourcePlatform;
  visibility: MemoryVisibility;
};

interface MemoryPage {
  memories: MemoryView[];
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

function memoryOrigin(idempotencyKey: string | null): MemoryView["origin"] {
  if (idempotencyKey?.startsWith("session:")) return "automatic";
  if (idempotencyKey?.startsWith("tool:")) return "explicit";
  return "other";
}

function toMemoryView(
  row: typeof juniorMemoryMemories.$inferSelect,
): MemoryView {
  const memory = parseMemoryRow(row);
  return {
    ...memory,
    origin: memoryOrigin(row.idempotencyKey),
    sourcePlatform: row.sourcePlatform,
    visibility: memory.scope,
  };
}

function cursorFilters(input: MemoryPageInput) {
  return {
    kind: input.kind,
    origin: input.origin,
    query: input.query?.trim() || undefined,
    visibility: input.visibility,
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

/** Archive one active private memory owned by the authenticated User. */
export async function archiveMemory(db: MemoryDb, userId: string, id: string) {
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
        activeMemoryPredicate(userId, nowMs, "private"),
        eq(juniorMemoryMemories.id, memoryId),
      ),
    )
    .returning();
  if (!updated[0]) throw new MemoryNotFoundError();
  await db
    .delete(juniorMemoryEmbeddings)
    .where(eq(juniorMemoryEmbeddings.memoryId, memoryId));
  return parseMemoryRow(updated[0]);
}

/** Read one active memory visible to the authenticated User. */
export async function getMemory(
  db: MemoryDb,
  userId: string,
  id: string,
): Promise<MemoryView> {
  const memoryId = nonEmptyStringSchema.parse(id);
  const nowMs = Date.now();
  const rows = await db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(
        activeMemoryPredicate(userId, nowMs),
        eq(juniorMemoryMemories.id, memoryId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new MemoryNotFoundError();
  return toMemoryView(rows[0]);
}

/** List one stable page of active memory visible to the authenticated User. */
export async function listMemories(
  db: MemoryDb,
  userId: string,
  input: MemoryPageInput,
): Promise<MemoryPage> {
  input = pageInputSchema.parse(input);
  const filters = cursorFilters(input);
  const cursor = decodeCursor(input.cursor, filters);
  const active = activeMemoryPredicate(userId, Date.now(), input.visibility);
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
  const memories = rows.slice(0, input.limit).map(toMemoryView);
  const last = memories.at(-1);
  if (rows.length <= input.limit || !last) return { memories };
  const next = { createdAtMs: last.createdAtMs, id: last.id };
  return { memories, nextCursor: encodeCursor(next, filters) };
}

/** Summarize active memory visible to the authenticated User. */
export async function getMemoryStats(db: MemoryDb, userId: string) {
  const nowMs = Date.now();
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
      embedded: sql<number>`count(${juniorMemoryEmbeddings.memoryId})`.mapWith(
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
    .where(activeMemoryPredicate(userId, nowMs));
  if (!counts) throw new Error("Memory stats query returned no row.");
  return counts;
}

/** Read daily memory creation totals visible to the authenticated User in UTC. */
export async function getMemoryTimeline(
  db: MemoryDb,
  userId: string,
  days: number,
) {
  days = timelineDaysSchema.parse(days);
  const todayMs = Date.parse(`${utcDate(Date.now())}T00:00:00.000Z`);
  const startMs = todayMs - (days - 1) * DAY_MS;
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
        visibleScopePredicate(userId),
        gt(juniorMemoryMemories.createdAtMs, startMs - 1),
      ),
    )
    .groupBy(
      sql`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    );
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return Array.from({ length: days }, (_, index) => {
    const date = utcDate(startMs + index * DAY_MS);
    const row = byDate.get(date);
    return {
      date,
      private: row?.private ?? 0,
      public: row?.public ?? 0,
    };
  });
}
