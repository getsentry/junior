import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  conversationEventDataSchema,
  conversationEventSchema,
  contextEpochStartSchema,
  newConversationEventSchema,
  type ConversationEvent,
  type ConversationEventStore,
  type ConversationEventData,
  type ContextEpochStart,
  type ContextEpochMessage,
  type NewConversationEvent,
} from "../history";
import { ensureConversationRow } from "./conversation-row";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { sanitizePostgresJson } from "@/db/postgres-json";
import { withConversationEventLock } from "./event-lock";

type ConversationEventRow = typeof juniorConversationEvents.$inferSelect;
type ConversationEventInsert = typeof juniorConversationEvents.$inferInsert;
type PersistedConversationEvent = {
  data: ConversationEventData;
  idempotencyKey?: string;
  createdAtMs: number;
};

function messageRole(data: ConversationEventData): string | null {
  if (data.type === "message") {
    return data.message.role;
  }
  return data.type === "visible_message_recorded" ? data.role : null;
}

/** Split validated event data into column-lifted and JSON payload fields. */
function insertFromEvent(
  conversationId: string,
  seq: number,
  contextEpoch: number,
  event: PersistedConversationEvent,
): ConversationEventInsert {
  const { type, ...payload } = conversationEventDataSchema.parse(event.data);
  return {
    conversationId,
    seq,
    contextEpoch,
    schemaVersion: 1,
    idempotencyKey: event.idempotencyKey ?? null,
    type,
    role: messageRole(event.data),
    payload: sanitizePostgresJson(payload),
    createdAt: new Date(event.createdAtMs),
  };
}

/** Parse one physical event row into the canonical domain envelope. */
function eventFromRow(row: ConversationEventRow): ConversationEvent {
  return conversationEventSchema.parse({
    schemaVersion: row.schemaVersion,
    seq: row.seq,
    contextEpoch: row.contextEpoch,
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    createdAtMs: row.createdAt.getTime(),
    data: { ...row.payload, type: row.type },
  });
}

function epochMessageEvent(message: ContextEpochMessage): NewConversationEvent {
  return {
    data: {
      type: "message",
      message: message.message,
      ...(message.provenance ? { provenance: message.provenance } : {}),
    },
    createdAtMs: message.createdAtMs,
  };
}

class SqlConversationEventStore implements ConversationEventStore {
  constructor(private readonly executor: JuniorSqlDatabase) {}

  async append(
    conversationId: string,
    events: NewConversationEvent[],
  ): Promise<void> {
    const parsed = events.map((event) =>
      newConversationEventSchema.parse(event),
    );
    if (parsed.length === 0) {
      return;
    }
    const newestCreatedAtMs = Math.max(
      ...parsed.map((event) => event.createdAtMs),
    );
    await withConversationEventLock(this.executor, conversationId, async () => {
      await ensureConversationRow(
        this.executor,
        conversationId,
        newestCreatedAtMs,
      );
      await this.executor
        .db()
        .update(juniorConversations)
        .set({ archivedAt: null })
        .where(
          and(
            eq(juniorConversations.conversationId, conversationId),
            isNotNull(juniorConversations.archivedAt),
          ),
        );
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
      const pending = parsed.filter(
        (event) =>
          event.idempotencyKey === undefined ||
          !persistedKeys.has(event.idempotencyKey),
      );
      if (pending.length === 0) {
        return;
      }
      const cursor = await this.readCursor(conversationId);
      const contextEpoch = cursor.maxEpoch ?? 0;
      let seq = cursor.nextSeq;
      const rows = pending.map((event) =>
        insertFromEvent(conversationId, seq++, contextEpoch, event),
      );
      await this.executor
        .db()
        .insert(juniorConversationEvents)
        .values(rows)
        .onConflictDoNothing({
          target: [
            juniorConversationEvents.conversationId,
            juniorConversationEvents.idempotencyKey,
          ],
        });
    });
  }

  async startEpoch(
    conversationId: string,
    opts: ContextEpochStart,
  ): Promise<void> {
    const parsed = contextEpochStartSchema.parse(opts);
    await withConversationEventLock(this.executor, conversationId, async () => {
      await ensureConversationRow(this.executor, conversationId, Date.now());
      await this.executor
        .db()
        .update(juniorConversations)
        .set({ archivedAt: null })
        .where(
          and(
            eq(juniorConversations.conversationId, conversationId),
            isNotNull(juniorConversations.archivedAt),
          ),
        );
      const cursor = await this.readCursor(conversationId);
      const contextEpoch =
        parsed.reason === "initial"
          ? (cursor.maxEpoch ?? 0)
          : (cursor.maxEpoch ?? -1) + 1;
      let seq = cursor.nextSeq;
      const { messages, ...binding } = parsed;
      const marker: PersistedConversationEvent = {
        data: { type: "context_epoch_started", ...binding },
        createdAtMs: Date.now(),
      };
      const rows = [marker, ...messages.map(epochMessageEvent)].map((event) =>
        insertFromEvent(conversationId, seq++, contextEpoch, event),
      );
      await this.executor.db().insert(juniorConversationEvents).values(rows);
    });
  }

  async loadCurrentEpoch(conversationId: string): Promise<ConversationEvent[]> {
    const cursor = await this.readCursor(conversationId);
    if (cursor.maxEpoch === null) {
      return [];
    }
    const rows = await this.executor
      .db()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.contextEpoch, cursor.maxEpoch),
        ),
      )
      .orderBy(asc(juniorConversationEvents.seq));
    return rows.map(eventFromRow);
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

  /** Read the next `seq` and current highest epoch for one conversation. */
  private async readCursor(
    conversationId: string,
  ): Promise<{ maxEpoch: number | null; nextSeq: number }> {
    const rows = await this.executor
      .db()
      .select({
        maxSeq: sql<number | null>`max(${juniorConversationEvents.seq})`,
        maxEpoch: sql<
          number | null
        >`max(${juniorConversationEvents.contextEpoch})`,
      })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, conversationId));
    const maxSeq = rows[0]?.maxSeq;
    const maxEpoch = rows[0]?.maxEpoch;
    return {
      maxEpoch:
        maxEpoch === null || maxEpoch === undefined ? null : Number(maxEpoch),
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
