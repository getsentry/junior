import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorAttachments,
  juniorConversationEvents,
  juniorIdentities,
  juniorMessageAttachments,
} from "@/db/schema";
import { batchMessageLinks, urlAttachmentId } from "../message-links";
import { conversationDetailTouch } from "./detail-version";

type EventRow = {
  conversationId: string;
  createdAt: Date;
  payload: Record<string, unknown>;
  seq: number;
  type: string;
};

/**
 * The stored seqs of the Messages that new `message_updated` rows edit, so
 * their links can be replaced. An edit of a Message that is not stored yet
 * finds no seq here.
 */
async function readEditedMessageSeqs(
  executor: JuniorSqlDatabase,
  conversationId: string,
  rows: readonly EventRow[],
): Promise<Map<string, number>> {
  const messageIds = rows.flatMap(({ payload, type }) =>
    type === "message_updated" && typeof payload["messageId"] === "string"
      ? [payload["messageId"]]
      : [],
  );
  if (messageIds.length === 0) return new Map();
  const e = juniorConversationEvents;
  const messageId = sql<string>`${e.payload}->>'messageId'`;
  const stored = await executor
    .db()
    .select({ messageId, seq: e.seq })
    .from(e)
    .where(
      and(
        eq(e.conversationId, conversationId),
        eq(e.type, "message"),
        inArray(messageId, messageIds),
      ),
    )
    .orderBy(desc(e.seq));
  // Newest first, so the first save of a duplicate id wins.
  return new Map(stored.map((row) => [row.messageId, row.seq]));
}

/**
 * Store the web links of new message events as `url` Attachments of their
 * Conversation, and where each message uses them. Call it in the transaction
 * that inserts the events, so a message is never stored without its links.
 */
export async function writeMessageLinks(
  executor: JuniorSqlDatabase,
  conversationId: string,
  rows: readonly EventRow[],
): Promise<void> {
  const { links, replacedSeqs } = batchMessageLinks(
    rows,
    await readEditedMessageSeqs(executor, conversationId, rows),
  );
  const db = executor.db();
  // An edit or hydration rewrites a message's links. A link that stays keeps
  // its queued attach, so the heartbeat still adds it to linked work.
  const attachDue = new Map<string, Date>();
  if (replacedSeqs.length > 0) {
    const replaced = await db
      .delete(juniorMessageAttachments)
      .where(
        and(
          eq(juniorMessageAttachments.conversationId, conversationId),
          inArray(juniorMessageAttachments.seq, replacedSeqs),
        ),
      )
      .returning({
        attachDueAt: juniorMessageAttachments.attachDueAt,
        attachmentId: juniorMessageAttachments.attachmentId,
        seq: juniorMessageAttachments.seq,
      });
    for (const row of replaced) {
      if (row.attachDueAt) {
        attachDue.set(`${row.seq}:${row.attachmentId}`, row.attachDueAt);
      }
    }
  }
  await insertLinks(executor, conversationId, links, attachDue);
}

/**
 * Queue the web links of a Turn's input Messages that a person wrote, so the
 * heartbeat adds them to the Conversation's linked work
 * (`chat/conversations/sent-links.ts`). Call it in the transaction that
 * stores the `turn_started` event. The author of a Turn input Message takes
 * part from that Turn on, as `recordTurnInputParticipants` records. An Event
 * Message keeps its author only for attribution, so its links stay out.
 */
export async function queueTurnInputLinks(
  executor: JuniorSqlDatabase,
  args: {
    at: Date;
    conversationId: string;
    inputMessageIds: readonly string[];
  },
): Promise<void> {
  const { conversationId } = args;
  if (args.inputMessageIds.length === 0) return;
  const e = juniorConversationEvents;
  const identities = juniorIdentities;
  const db = executor.db();
  const sent = await db
    .select({ seq: e.seq })
    .from(e)
    .innerJoin(identities, eq(identities.id, e.actorIdentityId))
    .where(
      and(
        eq(e.conversationId, conversationId),
        eq(e.type, "message"),
        eq(sql`${e.payload}->>'role'`, "user"),
        inArray(sql<string>`${e.payload}->>'messageId'`, [
          ...args.inputMessageIds,
        ]),
        sql`${e.payload}->'meta'->>'eventType' IS NULL`,
        eq(identities.kind, "user"),
        isNotNull(identities.userId),
      ),
    );
  if (sent.length === 0) return;
  const m = juniorMessageAttachments;
  const a = juniorAttachments;
  await db
    .update(m)
    .set({ attachDueAt: args.at })
    .where(
      and(
        eq(m.conversationId, conversationId),
        inArray(
          m.seq,
          sent.map((row) => row.seq),
        ),
        inArray(
          m.attachmentId,
          db
            .select({ id: a.id })
            .from(a)
            .where(
              and(eq(a.conversationId, conversationId), eq(a.kind, "url")),
            ),
        ),
      ),
    );
}

async function insertLinks(
  executor: JuniorSqlDatabase,
  conversationId: string,
  links: ReadonlyArray<{
    createdAt: Date;
    position: number | null;
    seq: number;
    url: string;
  }>,
  attachDue: ReadonlyMap<string, Date> = new Map(),
): Promise<void> {
  if (links.length === 0) return;
  const db = executor.db();
  const withIds = links.map((link) => ({
    ...link,
    attachmentId: urlAttachmentId(conversationId, link.url),
  }));
  const attachments = new Map(
    withIds.map((link) => [
      link.attachmentId,
      {
        conversationId,
        createdAt: link.createdAt,
        id: link.attachmentId,
        kind: "url",
        url: link.url,
      },
    ]),
  );
  await db
    .with(conversationDetailTouch(db, [conversationId]))
    .insert(juniorAttachments)
    .values([...attachments.values()])
    .onConflictDoNothing({ target: juniorAttachments.id });
  await db
    .insert(juniorMessageAttachments)
    .values(
      withIds.map(({ attachmentId, position, seq }) => ({
        attachDueAt: attachDue.get(`${seq}:${attachmentId}`) ?? null,
        attachmentId,
        conversationId,
        position,
        seq,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Copy the links of the copied messages into a fork. Copies keep their seq,
 * and the fork gets its own `url` Attachments.
 */
export async function copyMessageLinks(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    seqs: readonly number[];
    sourceConversationId: string;
  },
): Promise<void> {
  if (args.seqs.length === 0) return;
  const m = juniorMessageAttachments;
  const a = juniorAttachments;
  const links = await executor
    .db()
    .select({
      createdAt: a.createdAt,
      position: m.position,
      seq: m.seq,
      url: a.url,
    })
    .from(m)
    .innerJoin(a, eq(a.id, m.attachmentId))
    .where(
      and(
        eq(m.conversationId, args.sourceConversationId),
        inArray(m.seq, [...args.seqs]),
        isNull(a.deleteRequestedAt),
      ),
    );
  await insertLinks(
    executor,
    args.conversationId,
    links.flatMap(({ url, ...link }) =>
      url === null ? [] : [{ ...link, url }],
    ),
  );
}

/** Delete where purged messages use Attachments, with the messages. */
export async function deleteMessageLinks(
  executor: JuniorSqlDatabase,
  conversationIds: readonly string[],
): Promise<void> {
  await executor
    .db()
    .delete(juniorMessageAttachments)
    .where(
      inArray(juniorMessageAttachments.conversationId, [...conversationIds]),
    );
}
