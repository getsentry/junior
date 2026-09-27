import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, getTableColumns, lte, or, sql } from "drizzle-orm";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { WebActor } from "@/chat/actor";
import { botConfig } from "@/chat/config";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import {
  juniorAttachments,
  juniorConversationAnnotations,
  juniorConversationEvents,
  juniorConversations,
} from "@/db/schema";
import { readMessageCardRefs } from "./cards";
import { decodeStoredConversationEvent } from "./history";
import { copyForkAttachments } from "./fork-attachments";
import { withConversationMutationLock } from "./sql/store";
import {
  createConversationId,
  recordWebConversationActivity,
} from "./web-input";

/** The selected history cannot be forked. */
export class ConversationForkError extends Error {}

/** Copy history into a new Conversation without starting a Turn. */
export async function forkConversation(args: {
  actor: WebActor;
  attachmentStorage: AttachmentStorage;
  conversationId: string;
  messageSeq: number;
  idempotencyKey: string;
  /** Check access before copying files and again before saving the fork. */
  authorize(): Promise<"private" | "public">;
}): Promise<{ conversationId: string; prefill: string }> {
  if (!args.actor.email) throw new Error("Web Actor requires a verified email");
  await args.authorize();
  const executor = getSqlExecutor();
  const conversationId = createConversationId({
    actorEmail: args.actor.email,
    idempotencyKey: JSON.stringify([
      "fork",
      args.conversationId,
      args.messageSeq,
      args.idempotencyKey,
    ]),
  }).replace("local:web:", "local:web:fork-");
  const source = await getConversationStore().get({
    conversationId: args.conversationId,
  });
  if (!source || source.transcriptPurgedAtMs !== undefined)
    throw new ConversationForkError(
      "Conversation history is no longer available.",
    );
  const sourceRows = await getDb()
    .select()
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, args.conversationId),
        lte(juniorConversationEvents.seq, args.messageSeq),
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
  const selected = sourceRows.at(-1);
  if (
    selected?.seq !== args.messageSeq ||
    selected.type !== "message" ||
    (selected.payload.role !== "assistant" && selected.payload.role !== "user")
  )
    throw new ConversationForkError("Select a user or assistant message.");
  const prefill =
    selected.payload.role === "user" ? String(selected.payload.text) : "";
  const replies = sourceRows.filter(
    (row) => row.type === "message" && row.payload.role === "assistant",
  );
  const boundary = replies.at(-1);
  const throughSeq = boundary?.seq ?? -1;
  const rows = sourceRows.filter((row) => row.seq <= throughSeq);
  if (boundary) {
    const events = rows
      .filter((row) => row.historyVersion === boundary.historyVersion)
      .map((row) =>
        decodeStoredConversationEvent({
          schemaVersion: row.schemaVersion,
          seq: row.seq,
          historyVersion: row.historyVersion,
          type: row.type,
          payload: row.payload,
          createdAtMs: row.createdAt.getTime(),
          idempotencyKey: row.idempotencyKey ?? undefined,
        }),
      );
    const { messages, seqs } = projectConversationEvents(events, {
      defaultProfile: botConfig.defaultProfile,
    });
    const previousReplySeq = replies.at(-2)?.seq ?? -1;
    const tail = messages.at(-1);
    const pending = new Set<string>();
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const part of message.content)
          if (part.type === "toolCall") pending.add(part.id);
      } else if (message.role === "toolResult")
        pending.delete(message.toolCallId);
    }
    if (
      (seqs.at(-1) ?? -1) <= previousReplySeq ||
      tail?.role !== "assistant" ||
      pending.size > 0 ||
      tail.stopReason === "error" ||
      tail.stopReason === "aborted"
    )
      throw new ConversationForkError(
        "This reply has no completed agent history to fork.",
      );
  }
  if (await getConversationStore().get({ conversationId }))
    return { conversationId, prefill };
  const refs = rows.flatMap((row) =>
    row.type === "message" || row.type === "message_updated"
      ? readMessageCardRefs(
          (row.payload.meta ?? {}) as {
            cards?: unknown;
            objectCards?: unknown;
          },
        )
      : [],
  );
  const writtenKeys: string[] = [];
  let published = false;
  try {
    const attachments = await copyForkAttachments({
      sourceConversationId: args.conversationId,
      conversationId,
      rows,
      storage: args.attachmentStorage,
      writtenKeys,
    });
    published = await withConversationMutationLock(
      executor,
      args.conversationId,
      async () => {
        const visibility = await args.authorize();
        const current = await getConversationStore().get({
          conversationId: args.conversationId,
        });
        const [currentSelected] = await getDb()
          .select()
          .from(juniorConversationEvents)
          .where(
            and(
              eq(juniorConversationEvents.conversationId, args.conversationId),
              eq(juniorConversationEvents.seq, args.messageSeq),
            ),
          );
        if (
          !current ||
          current.transcriptPurgedAtMs !== undefined ||
          !isDeepStrictEqual(currentSelected, selected)
        )
          throw new ConversationForkError(
            "Conversation history changed. Try again.",
          );
        // The source lock also prevents retries from creating the fork twice.
        if (await getConversationStore().get({ conversationId })) return false;
        await recordWebConversationActivity({
          actor: args.actor,
          conversationId,
          nowMs: Date.now(),
          rootVisibility: visibility,
        });
        await getDb()
          .update(juniorConversations)
          .set({ title: source.title ?? null, inheritedThroughSeq: throughSeq })
          .where(eq(juniorConversations.conversationId, conversationId));
        await getDb()
          .insert(juniorConversationEvents)
          .select(
            getDb()
              .select({
                ...getTableColumns(juniorConversationEvents),
                conversationId: sql<string>`${conversationId}`.as(
                  "conversation_id",
                ),
              })
              .from(juniorConversationEvents)
              .where(
                and(
                  eq(
                    juniorConversationEvents.conversationId,
                    args.conversationId,
                  ),
                  lte(juniorConversationEvents.seq, throughSeq),
                ),
              ),
          );
        if (attachments.length)
          await getDb().insert(juniorAttachments).values(attachments);
        if (refs.length) {
          await getDb()
            .insert(juniorConversationAnnotations)
            .select(
              getDb()
                .select({
                  ...getTableColumns(juniorConversationAnnotations),
                  conversationId: sql<string>`${conversationId}`.as(
                    "conversation_id",
                  ),
                })
                .from(juniorConversationAnnotations)
                .where(
                  and(
                    eq(
                      juniorConversationAnnotations.conversationId,
                      args.conversationId,
                    ),
                    or(
                      ...refs.map((ref) =>
                        and(
                          eq(juniorConversationAnnotations.plugin, ref.plugin),
                          eq(juniorConversationAnnotations.kind, ref.kind),
                          eq(juniorConversationAnnotations.key, ref.key),
                        ),
                      ),
                    ),
                  ),
                ),
            );
        }
        return true;
      },
    );
    return { conversationId, prefill };
  } finally {
    if (!published && writtenKeys.length)
      await args.attachmentStorage.delete(writtenKeys);
  }
}
