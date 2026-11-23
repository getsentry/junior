/**
 * Memory access for an authenticated User.
 *
 * Every User can read public memory.
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  or,
  sql,
} from "drizzle-orm";
import * as z from "zod";
import {
  juniorMemoryEmbeddings,
  juniorMemoryMemories,
  memoryMentionDocument,
} from "@/db/schema/memory";
import { publicMemoryScope } from "./scope";
import { parseMemoryRow, type MemoryDb, type MemoryRecord } from "./store";
import { MEMORY_KINDS, type MemorySourcePlatform } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const nonEmptyStringSchema = z.string().min(1);
const cursorSchema = z
  .object({
    archived: z.literal(true).optional(),
    createdAtMs: z.number().finite(),
    id: nonEmptyStringSchema,
    kind: z.enum(MEMORY_KINDS).optional(),
    origin: z.enum(["automatic", "explicit"]).optional(),
    query: z.string().max(200).optional(),
    version: z.literal(1),
  })
  .strict();
const pageInputSchema = z
  .object({
    /** List archived memories that restore can make active. */
    archived: z.boolean().optional(),
    cursor: z.string().min(1).max(1_000).optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    limit: z.number().int().min(1).max(50),
    origin: z.enum(["automatic", "explicit"]).optional(),
    query: z.string().max(200).optional(),
  })
  .strict();
const timelineDaysSchema = z.number().int().min(1).max(365);

/** Memory fields returned to an authenticated User. */
export type MemoryView = MemoryRecord & {
  origin: "automatic" | "explicit" | "other";
  sourcePlatform: MemorySourcePlatform;
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

function activeMemoryPredicate(nowMs: number) {
  return and(
    publicScopePredicate(),
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, nowMs),
    ),
  );
}

/**
 * Archived public memories that restore can make active. Expired memories
 * stay archived, because the expiry sweep would archive them again.
 */
export function archivedMemoryPredicate(nowMs: number) {
  return and(
    publicScopePredicate(),
    isNotNull(juniorMemoryMemories.archivedAtMs),
    // A superseded preference row is an idempotency alias, not an archive.
    isNull(juniorMemoryMemories.supersededAtMs),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, nowMs),
    ),
  );
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The dashboard search highlight mirrors this split in `MemorySearchHighlight`.
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

/**
 * Match memory content that contains any search term. A query with no usable
 * term matches nothing, so a punctuation-only search does not list all memory.
 */
function searchPredicate(query: string | undefined) {
  if (query === undefined) return undefined;
  const terms = searchTerms(query);
  if (terms.length === 0) return sql`false`;
  return or(
    ...terms.map((term) => ilike(juniorMemoryMemories.content, `%${term}%`)),
  );
}

function memoryOrigin(idempotencyKey: string | null): MemoryView["origin"] {
  if (idempotencyKey?.startsWith("session:")) return "automatic";
  if (idempotencyKey?.startsWith("tool:")) return "explicit";
  return "other";
}

function toMemoryView(
  row: typeof juniorMemoryMemories.$inferSelect,
): MemoryView {
  return {
    ...parseMemoryRow(row),
    origin: memoryOrigin(row.idempotencyKey),
    sourcePlatform: row.sourcePlatform,
  };
}

function cursorFilters(input: MemoryPageInput) {
  return {
    archived: input.archived || undefined,
    kind: input.kind,
    origin: input.origin,
    query: input.query?.trim() || undefined,
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
      parsed.archived !== filters.archived ||
      parsed.query !== filters.query ||
      parsed.kind !== filters.kind ||
      parsed.origin !== filters.origin
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

/** Archive one active public memory. */
export async function archiveMemory(db: MemoryDb, id: string) {
  const memoryId = nonEmptyStringSchema.parse(id);
  const nowMs = Date.now();
  const updated = await db
    .update(juniorMemoryMemories)
    .set({
      archivedAtMs: nowMs,
      archiveReason: "user_removed",
    })
    .where(
      and(activeMemoryPredicate(nowMs), eq(juniorMemoryMemories.id, memoryId)),
    )
    .returning();
  if (!updated[0]) throw new MemoryNotFoundError();
  await db
    .delete(juniorMemoryEmbeddings)
    .where(eq(juniorMemoryEmbeddings.memoryId, memoryId));
  return parseMemoryRow(updated[0]);
}

/** Read one active or archived memory visible to the authenticated User. */
export async function getMemory(
  db: MemoryDb,
  id: string,
  options: { archived?: boolean } = {},
): Promise<MemoryView> {
  const memoryId = nonEmptyStringSchema.parse(id);
  const nowMs = Date.now();
  const state = options.archived
    ? archivedMemoryPredicate(nowMs)
    : activeMemoryPredicate(nowMs);
  const rows = await db
    .select()
    .from(juniorMemoryMemories)
    .where(and(state, eq(juniorMemoryMemories.id, memoryId)))
    .limit(1);
  if (!rows[0]) throw new MemoryNotFoundError();
  return toMemoryView(rows[0]);
}

/** Read the active memories in `ids` that the authenticated User can see. */
export async function getMemories(
  db: MemoryDb,
  ids: readonly string[],
): Promise<MemoryView[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(juniorMemoryMemories)
    .where(
      and(
        activeMemoryPredicate(Date.now()),
        inArray(juniorMemoryMemories.id, [...ids]),
      ),
    );
  return rows.map(toMemoryView);
}

// One menu of memories. More rows do not help a person who is still typing.
const MEMORY_SEARCH_LIMIT = 8;
// More words only narrow the match further.
const MEMORY_SEARCH_TERMS = 4;

/**
 * Find active public memory for quick pickers, such as the composer `@`
 * menu and Cmd+K, newest first. Each word of the query must start a word of
 * the memory. It reads the index `junior_memory_memories_mention_idx`.
 */
export async function searchMemories(
  db: MemoryDb,
  query: string,
): Promise<Array<{ content: string; id: string }>> {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(
    0,
    MEMORY_SEARCH_TERMS,
  );
  if (terms.length === 0) return [];
  // The terms hold only letters and digits, so they cannot add tsquery
  // syntax.
  const everyTerm = terms.map((term) => `${term}:*`).join(" & ");
  return await db
    .select({
      content: juniorMemoryMemories.content,
      id: juniorMemoryMemories.id,
    })
    .from(juniorMemoryMemories)
    .where(
      and(
        activeMemoryPredicate(Date.now()),
        sql`${memoryMentionDocument(juniorMemoryMemories)} @@ to_tsquery('simple', ${everyTerm})`,
      ),
    )
    .orderBy(
      desc(juniorMemoryMemories.createdAtMs),
      asc(juniorMemoryMemories.id),
    )
    .limit(MEMORY_SEARCH_LIMIT);
}

/** List one stable page of active memory visible to the authenticated User. */
export async function listMemories(
  db: MemoryDb,
  input: MemoryPageInput,
): Promise<MemoryPage> {
  input = pageInputSchema.parse(input);
  const filters = cursorFilters(input);
  const cursor = decodeCursor(input.cursor, filters);
  const state = input.archived
    ? archivedMemoryPredicate(Date.now())
    : activeMemoryPredicate(Date.now());
  const createdBefore = cursor
    ? or(
        lt(juniorMemoryMemories.createdAtMs, cursor.createdAtMs),
        and(
          eq(juniorMemoryMemories.createdAtMs, cursor.createdAtMs),
          gt(juniorMemoryMemories.id, cursor.id),
        ),
      )
    : undefined;
  const search = searchPredicate(input.query);
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
    .where(and(state, createdBefore, search, kind, origin))
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
export async function getMemoryStats(db: MemoryDb) {
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
      // EXISTS, not a join: a memory can have one vector per model.
      embedded:
        sql<number>`count(*) filter (where exists (select 1 from ${juniorMemoryEmbeddings} where ${juniorMemoryEmbeddings.memoryId} = ${juniorMemoryMemories.id}))`.mapWith(
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
    .where(activeMemoryPredicate(nowMs));
  if (!counts) throw new Error("Memory stats query returned no row.");
  return counts;
}

/** Read daily memory creation totals visible to the authenticated User in UTC. */
export async function getMemoryTimeline(db: MemoryDb, days: number) {
  days = timelineDaysSchema.parse(days);
  const todayMs = Date.parse(`${utcDate(Date.now())}T00:00:00.000Z`);
  const startMs = todayMs - (days - 1) * DAY_MS;
  const rows = await db
    .select({
      date: sql<string>`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as(
        "date",
      ),
      count: sql<number>`count(*)`.mapWith(Number),
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
  return Array.from({ length: days }, (_, index) => {
    const date = utcDate(startMs + index * DAY_MS);
    const row = byDate.get(date);
    return {
      date,
      count: row?.count ?? 0,
    };
  });
}

/** Read hourly memory creation totals visible to the authenticated User in UTC. */
export async function getMemoryTimelineHours(db: MemoryDb, hours = 24) {
  const end = new Date();
  end.setUTCMinutes(0, 0, 0);
  const startMs = end.getTime() - (hours - 1) * 60 * 60 * 1_000;
  const rows = await db
    .select({
      date: sql<string>`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24')`.as(
        "date",
      ),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(juniorMemoryMemories)
    .where(
      and(
        publicScopePredicate(),
        gt(juniorMemoryMemories.createdAtMs, startMs - 1),
      ),
    )
    .groupBy(
      sql`to_char(to_timestamp(${juniorMemoryMemories.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24')`,
    );
  const byHour = new Map(rows.map((row) => [row.date, row]));
  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(startMs + index * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 13);
    const row = byHour.get(date);
    return {
      date,
      count: row?.count ?? 0,
    };
  });
}
