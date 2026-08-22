/**
 * SQL operations over memories visible to one authenticated viewer.
 *
 * Public memory is visible to every authenticated viewer. Private memory is
 * visible when the viewer participates in a conversation in its source domain.
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

const nonEmptyStringSchema = z.string().min(1);
const memoryVisibilitySchema = z.enum(["private", "public"]);
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
    visibility: memoryVisibilitySchema.optional(),
  })
  .strict();
const viewerMemoryTimelineInputSchema = z
  .object({
    days: z.number().int().min(1).max(365),
  })
  .strict();
const DAY_MS = 24 * 60 * 60 * 1_000;

type ViewerMemoryPageInput = z.output<typeof viewerMemoryPageInputSchema>;

/** Safe provenance attached to one viewer-visible memory. */
export type ViewerMemory = MemoryRecord & {
  origin: "automatic" | "explicit" | "other";
  sourcePlatform: MemorySourcePlatform;
  visibility: MemoryVisibility;
};

export type MemoryVisibility = z.output<typeof memoryVisibilitySchema>;

/** Expected failure when a viewer cannot read the requested memory. */
export class ViewerMemoryNotFoundError extends Error {
  constructor() {
    super("Memory was not found for the authenticated viewer.");
    this.name = "ViewerMemoryNotFoundError";
  }
}

function publicScopePredicate() {
  return and(
    eq(juniorMemoryMemories.scope, publicMemoryScope.scope),
    eq(juniorMemoryMemories.scopeKey, publicMemoryScope.scopeKey),
  );
}

/** Match private domains for conversations materialized for this user. */
function privateScopePredicate(userId: string) {
  return and(
    eq(juniorMemoryMemories.scope, "private"),
    sql`exists (
      select 1
      from junior_conversations as viewer_conversation
      inner join junior_conversation_participants as viewer_participant
        on viewer_participant.root_conversation_id = viewer_conversation.root_conversation_id
      left join junior_destinations as viewer_destination
        on viewer_destination.id = viewer_conversation.destination_id
      where viewer_participant.user_id = ${userId}
        and (
          ${juniorMemoryMemories.scopeKey} = viewer_conversation.conversation_id
          or (
            ${juniorMemoryMemories.sourcePlatform} = 'slack'
            and viewer_destination.provider = 'slack'
            and ${juniorMemoryMemories.scopeKey} =
              'slack:' || viewer_destination.provider_tenant_id || ':' || viewer_destination.provider_destination_id
          )
        )
    )`,
  );
}

function viewerScopePredicate(userId: string, visibility?: MemoryVisibility) {
  if (visibility === "public") return publicScopePredicate();
  if (visibility === "private") return privateScopePredicate(userId);
  return or(publicScopePredicate(), privateScopePredicate(userId));
}

function activeViewerPredicate(
  userId: string,
  nowMs: number,
  visibility?: MemoryVisibility,
) {
  return and(
    viewerScopePredicate(userId, visibility),
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

function viewerMemory(
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

/** Build storage operations for memory visible to one authenticated viewer. */
export function createViewerMemoryCollection(
  db: MemoryDb,
  viewer: { id: string },
  options: { now?: () => number } = {},
) {
  const getNowMs = () => options.now?.() ?? Date.now();

  return {
    async archive(id: string) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = getNowMs();
      const updated = await db
        .update(juniorMemoryMemories)
        .set({
          archivedAtMs: nowMs,
          archiveReason: "user_removed",
        })
        .where(
          and(
            activeViewerPredicate(viewer.id, nowMs, "private"),
            eq(juniorMemoryMemories.id, memoryId),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new ViewerMemoryNotFoundError();
      }
      await db
        .delete(juniorMemoryEmbeddings)
        .where(eq(juniorMemoryEmbeddings.memoryId, memoryId));
      return parseMemoryRow(updated[0]);
    },

    async get(id: string) {
      const memoryId = nonEmptyStringSchema.parse(id);
      const nowMs = getNowMs();
      const rows = await db
        .select()
        .from(juniorMemoryMemories)
        .where(
          and(
            activeViewerPredicate(viewer.id, nowMs),
            eq(juniorMemoryMemories.id, memoryId),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw new ViewerMemoryNotFoundError();
      }
      return viewerMemory(rows[0]);
    },

    async list(input: ViewerMemoryPageInput) {
      input = viewerMemoryPageInputSchema.parse(input);
      const nowMs = getNowMs();
      const active = activeViewerPredicate(viewer.id, nowMs, input.visibility);

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
      const active = activeViewerPredicate(viewer.id, nowMs);
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
      input = viewerMemoryTimelineInputSchema.parse(input);
      const todayMs = Date.parse(`${utcDate(getNowMs())}T00:00:00.000Z`);
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
            viewerScopePredicate(viewer.id),
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
