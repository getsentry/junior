import {
  historyReplacementSchema,
  type HistoryReplacement,
} from "@/core/history/items";
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
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import {
  conversationEventDataSchema,
  decodeStoredConversationEvent,
  newConversationEventSchema,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationEventQuery,
  type ConversationEventStore,
  type ConversationEventData,
  type HistoryReplacementResult,
  type KnownConversationEventType,
  type MessageHistory,
  type MessagesSummarizedEvent,
  type NewConversationEvent,
} from "../history";
import { ensureConversationRow } from "./conversation-row";
import { refreshLastMessageAt } from "./last-message";
import {
  resolveEventActorIdentityId,
  stripPayloadAuthorIdentityId,
} from "./event-actor";
import { juniorConversationEvents } from "@/db/schema";
import { encodeHistoryPayload } from "../history-payload";
import { restoreArchivedPath } from "./conversation-tree";
import { withConversationEventLock } from "@/conversation-events/lock";
import {
  insertEventRows,
  insertHistoryReplacementRow,
  readEventCursor,
  unseenEvents,
  type NewEventRow,
} from "@/conversation-events/store";
import { writeMessageLinks } from "./message-links";
import {
  recordConversationParticipant,
  recordMentionedParticipants,
  rootConversationIsArchived,
} from "./participants";

type ConversationEventRow = typeof juniorConversationEvents.$inferSelect;
type PersistedConversationEvent = {
  data: ConversationEventData;
  idempotencyKey?: string | undefined;
  createdAtMs: number;
};

const messageHistoryEventTypes = [
  "message",
  "message_updated",
  "message_handled",
] as const;

const HUMAN_INSTRUCTION_PLATFORMS = new Set(["slack", "local", "web"]);

/**
 * True when a Turn input message is addressed to Junior, which subscribes its
 * author again (contract: `api/conversations/subscription.ts`). A Slack
 * message in a subscribed thread that does not mention Junior is marked
 * `explicitMention: false`. Other Sources, such as the dashboard and Slack
 * mentions and DMs, always address Junior.
 */
function eventAddressesJunior(data: ConversationEventData): boolean {
  return data.type === "message" && data.meta?.["explicitMention"] !== false;
}

/**
 * Whether one event should restore an archived conversation to the feed.
 *
 * Archive hides finished noise until a human comes back. Events,
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
  if (typeof meta["eventType"] === "string" && meta["eventType"].length > 0) {
    return false;
  }
  const author = meta["author"];
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

/** Validate and encode one event as a row for shared event storage. */
function rowFromEvent(
  event: PersistedConversationEvent,
  actorIdentityId?: string,
): NewEventRow {
  const stripped = stripPayloadAuthorIdentityId(event.data);
  const data = conversationEventDataSchema.parse(stripped);
  const encoded = encodeHistoryPayload(data);
  return {
    type: data.type,
    schemaVersion: encoded.schemaVersion,
    payload: encoded.payload,
    idempotencyKey: event.idempotencyKey,
    actorIdentityId,
    createdAtMs: event.createdAtMs,
  };
}

/** Read a Conversation's stored event rows as they are, in seq order. */
export async function readConversationEventRows(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ConversationEventRow[]> {
  return await db
    .select()
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId))
    .orderBy(asc(juniorConversationEvents.seq));
}

/** Parse one physical event row into the storage-compatible domain envelope. */
export function eventFromRow(row: ConversationEventRow): ConversationEvent {
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
    ...(row.idempotencyKey
      ? { idempotencyKey: row.idempotencyKey }
      : undefined),
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
  private readonly executor: JuniorSqlDatabase;

  constructor(executor: JuniorSqlDatabase) {
    this.executor = executor;
  }

  async append(
    conversationId: string,
    events: NewConversationEvent[],
    options: { activity?: "preserve" } = {},
  ): Promise<Array<Pick<ConversationEvent, "seq" | "historyVersion">>> {
    const parsed = events.map((event) =>
      newConversationEventSchema.parse(event),
    );
    if (parsed.length === 0) {
      return [];
    }
    return withConversationEventLock(
      this.executor,
      conversationId,
      async () => {
        const pending = await unseenEvents(
          this.executor,
          conversationId,
          parsed,
        );
        if (pending.length === 0) {
          return [];
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
        const newRows: NewEventRow[] = [];
        /* oxlint-disable no-await-in-loop -- Writes share the caller's executor and follow event order. */
        for (const event of pending) {
          const actorIdentityId = await resolveEventActorIdentityId(
            this.executor,
            {
              conversationId,
              data: event.data,
              nowMs: event.createdAtMs,
            },
          );
          newRows.push(rowFromEvent(event, actorIdentityId));
        }
        /* oxlint-enable no-await-in-loop */
        const rows = await insertEventRows(
          this.executor,
          conversationId,
          await readEventCursor(this.executor, conversationId),
          newRows,
        );
        await writeMessageLinks(this.executor, conversationId, rows);
        if (
          pending.some(
            (event) =>
              event.data.type === "message" ||
              event.data.type === "user_message",
          )
        ) {
          await refreshLastMessageAt(this.executor, conversationId);
        }
        /* oxlint-disable no-await-in-loop -- Writes share the caller's executor and follow event order. */
        for (const event of pending) {
          if (event.data.type === "turn_started") {
            await this.recordTurnInputParticipants(
              conversationId,
              event.data.inputMessageIds,
            );
          }
        }
        /* oxlint-enable no-await-in-loop */
        return rows.map((row) => ({
          seq: row.seq,
          historyVersion: row.historyVersion,
        }));
      },
    );
  }

  /**
   * Add the authors of Turn input messages to the conversation, and the
   * people that they mention in a public one. Only people who start a Turn,
   * or whom they mention, join it. Thread context, such as backfilled
   * or skipped messages, and Event Messages keep their author without
   * membership.
   */
  private async recordTurnInputParticipants(
    conversationId: string,
    inputMessageIds: readonly string[],
  ): Promise<void> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.type, "message"),
          inArray(
            sql<string>`${juniorConversationEvents.payload}->>'messageId'`,
            [...inputMessageIds],
          ),
        ),
      );
    // A person who restores an archived root also subscribes again, so a
    // restored root is never left in no feed (contract:
    // `api/conversations/subscription.ts`).
    const rootArchived = await rootConversationIsArchived(
      this.executor,
      conversationId,
    );
    let restores = false;
    /* oxlint-disable no-await-in-loop -- Writes share the caller's executor and follow event order. */
    for (const row of rows) {
      const { data } = eventFromRow(row);
      if (!row.actorIdentityId || data.type !== "message") continue;
      // An Event author writes its Message for attribution only. They did
      // not address this Conversation, so they do not join it.
      if (data.meta?.["eventType"]) continue;
      const unarchives = eventUnarchivesConversation(data);
      const isPerson = await recordConversationParticipant(this.executor, {
        actorIdentityId: row.actorIdentityId,
        conversationId,
        atMs: row.createdAt.getTime(),
        resubscribe: eventAddressesJunior(data) || (rootArchived && unarchives),
      });
      restores ||= isPerson && unarchives;
      if (isPerson) {
        await recordMentionedParticipants(this.executor, {
          atMs: row.createdAt.getTime(),
          conversationId,
          text: data.text,
        });
      }
    }
    /* oxlint-enable no-await-in-loop */
    // Archive is shared, so any person's message restores it for everyone.
    if (restores) {
      await restoreArchivedPath(this.executor.db(), conversationId);
    }
  }

  async replaceHistory(
    conversationId: string,
    replacement: HistoryReplacement,
    options: { expectedHistoryVersion?: number } = {},
  ): Promise<HistoryReplacementResult> {
    const parsed = historyReplacementSchema.parse(replacement);
    return withConversationEventLock(
      this.executor,
      conversationId,
      async () => {
        const cursor = await readEventCursor(this.executor, conversationId);
        const currentHistoryVersion = cursor.historyVersion;
        // Checked under the event lock so a concurrent replacement or a newer
        // compaction cannot slip in between the check and the write.
        if (
          options.expectedHistoryVersion !== undefined &&
          options.expectedHistoryVersion !== currentHistoryVersion
        ) {
          return {
            status: "conflict" as const,
            historyVersion: currentHistoryVersion,
          };
        }
        await ensureConversationRow(this.executor, conversationId, Date.now());
        const row = await insertHistoryReplacementRow(
          this.executor,
          conversationId,
          cursor,
          rowFromEvent(parsed),
        );
        return {
          status: "replaced" as const,
          historyVersion: row.historyVersion,
          seq: row.seq,
        };
      },
    );
  }

  async loadCurrentHistoryVersion(conversationId: string): Promise<number> {
    return (await readEventCursor(this.executor, conversationId))
      .historyVersion;
  }

  async loadCurrentHistory(
    conversationId: string,
  ): Promise<ConversationEvent[]> {
    const db = this.executor.db();
    // One statement: the current version and its events come from one snapshot.
    const currentHistoryVersion = db
      .select({
        historyVersion: sql<number>`max(${juniorConversationEvents.historyVersion})`,
      })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, conversationId));
    const rows = await db
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.historyVersion, currentHistoryVersion),
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

  async loadEventsAfter(
    conversationId: string,
    afterSeq: number,
  ): Promise<ConversationEvent[]> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          gt(juniorConversationEvents.seq, afterSeq),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    return rows.map(eventFromRow);
  }

  async loadHistoryContaining(
    conversationId: string,
    seq: number,
    throughSeq?: number,
  ): Promise<ConversationEvent[] | undefined> {
    const db = this.executor.db();
    const boundaryHistoryVersion = db
      .select({ historyVersion: juniorConversationEvents.historyVersion })
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.seq, seq),
        ),
      );
    // One statement. The range always includes the boundary row, so no rows
    // means the boundary does not exist.
    const rows = await db
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.historyVersion, boundaryHistoryVersion),
          throughSeq === undefined
            ? undefined
            : lte(juniorConversationEvents.seq, Math.max(seq, throughSeq)),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    if (rows.length === 0) return undefined;
    return rows
      .filter((row) => throughSeq === undefined || row.seq <= throughSeq)
      .map(eventFromRow);
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
    const historyFromSeq = compactionRow
      ? messagesSummarizedEventFromRow(compactionRow).data.historyFromSeq
      : 0;
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
    return { events: rows.map(eventFromRow), historyFromSeq };
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

  async loadEventsOfType(
    conversationId: string,
    type: KnownConversationEventType,
  ): Promise<ConversationEvent[]> {
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.type, type),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    return rows.map(eventFromRow);
  }

  async loadLatestEventOfTypes(
    conversationId: string,
    types: readonly KnownConversationEventType[],
  ): Promise<ConversationEvent | undefined> {
    const [row] = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          inArray(juniorConversationEvents.type, [...types]),
        ),
      )
      .orderBy(desc(juniorConversationEvents.seq))
      .limit(1);
    return row ? eventFromRow(row) : undefined;
  }

  async loadCurrentEventsOfType(
    conversationId: string,
    type: KnownConversationEventType,
  ): Promise<ConversationEvent[]> {
    const db = this.executor.db();
    // One statement, as in `loadCurrentHistory`. Older versions stay out of
    // the read, so its cost does not grow with every compaction.
    const currentHistoryVersion = db
      .select({
        historyVersion: sql<number>`max(${juniorConversationEvents.historyVersion})`,
      })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, conversationId));
    const rows = await db
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.historyVersion, currentHistoryVersion),
          eq(juniorConversationEvents.type, type),
        ),
      )
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
}

/** Create a SQL-backed canonical conversation event store. */
export function createSqlConversationEventStore(
  executor: JuniorSqlDatabase,
): ConversationEventStore {
  return new SqlConversationEventStore(executor);
}
