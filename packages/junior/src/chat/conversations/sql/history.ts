import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  conversationEventDataSchema,
  decodeStoredConversationEvent,
  historyReplacementSchema,
  newConversationEventSchema,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationEventQuery,
  type ConversationEventStore,
  type ConversationEventData,
  type HistoryReplacement,
  type MessageHistory,
  type MessagesSummarizedEvent,
  type NewConversationEvent,
} from "../history";
import { ensureConversationRow } from "./conversation-row";
import {
  resolveEventActorIdentityId,
  stripPayloadAuthorIdentityId,
} from "./event-actor";
import { juniorConversationEvents } from "@/db/schema";
import { sanitizePostgresJson } from "@/db/postgres-json";
import { withConversationEventLock } from "./event-lock";
import { recordConversationParticipant } from "./participants";

type ConversationEventRow = typeof juniorConversationEvents.$inferSelect;
type ConversationEventInsert = typeof juniorConversationEvents.$inferInsert;
type PersistedConversationEvent = {
  data: ConversationEventData;
  idempotencyKey?: string;
  createdAtMs: number;
};

const messageHistoryEventTypes = [
  "message",
  "message_updated",
  "message_handled",
] as const;

const HUMAN_INSTRUCTION_PLATFORMS = new Set(["slack", "local", "web"]);

/**
 * Whether one event should restore an archived conversation to the feed.
 *
 * Archive hides finished noise until a human comes back. Resource events,
 * turn lifecycle, compaction, and other system writes may still refresh
 * activity clocks, but they must not unarchive on their own.
 */
function eventUnarchivesConversation(data: ConversationEventData): boolean {
  if (data.type === "user_message") {
    const provenance = data.provenance;
    if (provenance.authority !== "instruction") return false;
    const platform = provenance.actor?.platform;
    return platform === undefined || HUMAN_INSTRUCTION_PLATFORMS.has(platform);
  }
  // message_updated is hydration/delivery on an existing row, not a new human.
  if (data.type !== "message") {
    return false;
  }
  if (data.role !== "user") return false;
  const meta = data.meta;
  if (!meta) return true;
  if (typeof meta.eventType === "string" && meta.eventType.length > 0) {
    return false;
  }
  const author = meta.author;
  if (
    author &&
    typeof author === "object" &&
    !Array.isArray(author) &&
    (author as { isBot?: unknown }).isBot === true
  ) {
    return false;
  }
  return true;
}

/** Split validated event data into column-lifted and JSON payload fields. */
function insertFromEvent(
  conversationId: string,
  seq: number,
  historyVersion: number,
  event: PersistedConversationEvent,
  actorIdentityId?: string,
): ConversationEventInsert {
  const stripped = stripPayloadAuthorIdentityId(event.data);
  const { type, ...payload } = conversationEventDataSchema.parse(stripped);
  return {
    conversationId,
    seq,
    historyVersion,
    schemaVersion: 1,
    idempotencyKey: event.idempotencyKey ?? null,
    type,
    payload: sanitizePostgresJson(payload),
    actorIdentityId: actorIdentityId ?? null,
    createdAt: new Date(event.createdAtMs),
  };
}

/** Parse one physical event row into the storage-compatible domain envelope. */
function eventFromRow(row: ConversationEventRow): ConversationEvent {
  const payload =
    row.actorIdentityId &&
    typeof row.payload === "object" &&
    row.payload !== null &&
    !Array.isArray(row.payload) &&
    (row.type === "message" || row.type === "message_updated") &&
    !("authorIdentityId" in row.payload)
      ? { ...row.payload, authorIdentityId: row.actorIdentityId }
      : row.payload;
  return decodeStoredConversationEvent({
    schemaVersion: row.schemaVersion,
    seq: row.seq,
    historyVersion: row.historyVersion,
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : undefined),
    createdAtMs: row.createdAt.getTime(),
    type: row.type,
    payload,
  });
}

/** Decode the summary row that defines a readable message-history suffix. */
function messagesSummarizedEventFromRow(
  row: ConversationEventRow,
): MessagesSummarizedEvent {
  const event = eventFromRow(row);
  if (event.schemaVersion !== 1 || event.data.type !== "messages_summarized") {
    throw new Error(
      "Message compaction row did not decode as messages_summarized",
    );
  }
  return { ...event, schemaVersion: 1, data: event.data };
}

class SqlConversationEventStore implements ConversationEventStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  async append(
    conversationId: string,
    events: NewConversationEvent[],
    options: { activity?: "preserve" } = {},
  ): Promise<void> {
    const parsed = events.map((event) =>
      newConversationEventSchema.parse(event),
    );
    if (parsed.length === 0) {
      return;
    }
    await withConversationEventLock(this.executor, conversationId, async () => {
      const existingKeys = parsed
        .map((event) => event.idempotencyKey)
        .filter((key): key is string => key !== undefined);
      const persistedKeys =
        existingKeys.length === 0
          ? new Set<string>()
          : new Set(
              (
                await this.executor
                  .db()
                  .select({ key: juniorConversationEvents.idempotencyKey })
                  .from(juniorConversationEvents)
                  .where(
                    and(
                      eq(
                        juniorConversationEvents.conversationId,
                        conversationId,
                      ),
                      inArray(
                        juniorConversationEvents.idempotencyKey,
                        existingKeys,
                      ),
                    ),
                  )
              ).flatMap((row) => (row.key ? [row.key] : [])),
            );
      const acceptedKeys = new Set(persistedKeys);
      const pending = parsed.filter((event) => {
        if (event.idempotencyKey === undefined) return true;
        if (acceptedKeys.has(event.idempotencyKey)) return false;
        acceptedKeys.add(event.idempotencyKey);
        return true;
      });
      if (pending.length === 0) {
        return;
      }
      const newestCreatedAtMs = Math.max(
        ...pending.map((event) => event.createdAtMs),
      );
      await ensureConversationRow(
        this.executor,
        conversationId,
        newestCreatedAtMs,
        options,
      );
      const cursor = await this.readCursor(conversationId);
      const historyVersion = cursor.maxHistoryVersion ?? 0;
      let seq = cursor.nextSeq;
      const rows: ConversationEventInsert[] = [];
      for (const event of pending) {
        const actorIdentityId = await resolveEventActorIdentityId(
          this.executor,
          {
            conversationId,
            data: event.data,
            nowMs: event.createdAtMs,
          },
        );
        rows.push(
          insertFromEvent(
            conversationId,
            seq++,
            historyVersion,
            event,
            actorIdentityId,
          ),
        );
        if (actorIdentityId) {
          await recordConversationParticipant(this.executor, {
            actorIdentityId,
            conversationId,
            atMs: event.createdAtMs,
            restoreArchive: eventUnarchivesConversation(event.data),
          });
        }
      }
      await this.executor.db().insert(juniorConversationEvents).values(rows);
    });
  }

  async replaceHistory(
    conversationId: string,
    replacement: HistoryReplacement,
  ): Promise<void> {
    const parsed = historyReplacementSchema.parse(replacement);
    await withConversationEventLock(this.executor, conversationId, async () => {
      await ensureConversationRow(this.executor, conversationId, Date.now());
      const cursor = await this.readCursor(conversationId);
      const historyVersion = (cursor.maxHistoryVersion ?? 0) + 1;
      await this.executor
        .db()
        .insert(juniorConversationEvents)
        .values(
          insertFromEvent(
            conversationId,
            cursor.nextSeq,
            historyVersion,
            parsed,
          ),
        );
    });
  }

  async loadCurrentHistory(
    conversationId: string,
  ): Promise<ConversationEvent[]> {
    const cursor = await this.readCursor(conversationId);
    if (cursor.maxHistoryVersion === null) {
      return [];
    }
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.historyVersion, cursor.maxHistoryVersion),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    return rows.map(eventFromRow);
  }

  async loadByIdempotencyKey(
    conversationId: string,
    idempotencyKey: string,
  ): Promise<ConversationEvent | undefined> {
    const [row] = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row ? eventFromRow(row) : undefined;
  }

  async loadHistoryContaining(
    conversationId: string,
    seq: number,
    throughSeq?: number,
  ): Promise<ConversationEvent[] | undefined> {
    const [boundary] = await this.executor
      .db()
      .select({ historyVersion: juniorConversationEvents.historyVersion })
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.seq, seq),
        ),
      )
      .limit(1);
    if (!boundary) return undefined;

    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.historyVersion, boundary.historyVersion),
          throughSeq === undefined
            ? undefined
            : lte(juniorConversationEvents.seq, throughSeq),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    return rows.map(eventFromRow);
  }

  async loadLatestStructuredEvent(
    conversationId: string,
    namespace: string,
    name: string,
  ): Promise<ConversationEvent | undefined> {
    const [row] = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.type, "structured_event"),
          sql`${juniorConversationEvents.payload}->>'namespace' = ${namespace}`,
          sql`${juniorConversationEvents.payload}->>'name' = ${name}`,
        ),
      )
      .orderBy(desc(juniorConversationEvents.seq))
      .limit(1);
    return row ? eventFromRow(row) : undefined;
  }

  async loadLatestInstruction(
    conversationId: string,
  ): Promise<ConversationEvent | undefined> {
    const [row] = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.type, "user_message"),
          sql`${juniorConversationEvents.payload}->'provenance'->>'authority' = 'instruction'`,
        ),
      )
      .orderBy(desc(juniorConversationEvents.seq))
      .limit(1);
    return row ? eventFromRow(row) : undefined;
  }

  async loadMessageHistory(conversationId: string): Promise<MessageHistory> {
    const [compactionRow] = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.type, "messages_summarized"),
        ),
      )
      .orderBy(desc(juniorConversationEvents.seq))
      .limit(1);
    const compaction = compactionRow
      ? messagesSummarizedEventFromRow(compactionRow)
      : undefined;
    const historyFromSeq = compaction?.data.historyFromSeq ?? 0;
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          inArray(juniorConversationEvents.type, messageHistoryEventTypes),
          gte(juniorConversationEvents.seq, historyFromSeq),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    return { events: rows.map(eventFromRow), compaction, historyFromSeq };
  }

  async loadHistory(conversationId: string): Promise<ConversationEvent[]> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, conversationId))
      .orderBy(asc(juniorConversationEvents.seq));
    return rows.map(eventFromRow);
  }

  async query(
    conversationId: string,
    query: ConversationEventQuery,
  ): Promise<ConversationEventPage> {
    if (query.limit < 1) {
      throw new Error("Conversation event query limit must be at least 1");
    }
    if (
      query.afterSeq !== undefined &&
      query.beforeSeq !== undefined &&
      query.afterSeq >= query.beforeSeq
    ) {
      return { events: [], hasOlder: false, hasNewer: false };
    }

    const typeFilter =
      query.types && query.types.length > 0
        ? inArray(juniorConversationEvents.type, [...query.types])
        : undefined;
    const bounds = and(
      eq(juniorConversationEvents.conversationId, conversationId),
      query.afterSeq === undefined
        ? undefined
        : gt(juniorConversationEvents.seq, query.afterSeq),
      query.beforeSeq === undefined
        ? undefined
        : lt(juniorConversationEvents.seq, query.beforeSeq),
      typeFilter,
    );

    // Default to the newest matching page so debug callers start near recent activity.
    const newestFirst = query.afterSeq === undefined;
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(bounds)
      .orderBy(
        newestFirst
          ? desc(juniorConversationEvents.seq)
          : asc(juniorConversationEvents.seq),
      )
      .limit(query.limit + 1);

    const overflow = rows.length > query.limit;
    const pageRows = overflow ? rows.slice(0, query.limit) : rows;
    const events = (newestFirst ? [...pageRows].reverse() : pageRows).map(
      eventFromRow,
    );

    if (events.length === 0) {
      return { events, hasOlder: false, hasNewer: false };
    }

    const firstSeq = events[0]!.seq;
    const lastSeq = events[events.length - 1]!.seq;
    const hasOlder =
      newestFirst && overflow
        ? true
        : await this.hasMatchingEvent({
            conversationId,
            beforeSeq: firstSeq,
            typeFilter,
          });
    const hasNewer =
      !newestFirst && overflow
        ? true
        : await this.hasMatchingEvent({
            conversationId,
            afterSeq: lastSeq,
            typeFilter,
          });

    return { events, hasOlder, hasNewer };
  }

  /** Return whether any matching event exists inside the exclusive seq window. */
  private async hasMatchingEvent(args: {
    afterSeq?: number;
    beforeSeq?: number;
    conversationId: string;
    typeFilter: ReturnType<typeof inArray> | undefined;
  }): Promise<boolean> {
    if (
      args.afterSeq !== undefined &&
      args.beforeSeq !== undefined &&
      args.afterSeq >= args.beforeSeq
    ) {
      return false;
    }
    const [row] = await this.executor
      .db()
      .select({ seq: juniorConversationEvents.seq })
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, args.conversationId),
          args.afterSeq === undefined
            ? undefined
            : gt(juniorConversationEvents.seq, args.afterSeq),
          args.beforeSeq === undefined
            ? undefined
            : lt(juniorConversationEvents.seq, args.beforeSeq),
          args.typeFilter,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Read the next sequence and active model-history version. */
  private async readCursor(
    conversationId: string,
  ): Promise<{ maxHistoryVersion: number | null; nextSeq: number }> {
    const rows = await this.executor
      .db()
      .select({
        maxSeq: sql<number | null>`max(${juniorConversationEvents.seq})`,
        maxHistoryVersion: sql<
          number | null
        >`max(${juniorConversationEvents.historyVersion})`,
      })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, conversationId));
    const maxSeq = rows[0]?.maxSeq;
    const maxHistoryVersion = rows[0]?.maxHistoryVersion;
    return {
      maxHistoryVersion:
        maxHistoryVersion === null || maxHistoryVersion === undefined
          ? null
          : Number(maxHistoryVersion),
      nextSeq: maxSeq === null || maxSeq === undefined ? 0 : Number(maxSeq) + 1,
    };
  }
}

/** Create a SQL-backed canonical conversation event store. */
export function createSqlConversationEventStore(
  executor: JuniorSqlDatabase,
): ConversationEventStore {
  return new SqlConversationEventStore(executor);
}
