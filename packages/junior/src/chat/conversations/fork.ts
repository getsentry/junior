import { and, asc, eq, lte } from "drizzle-orm";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { copyForkAttachments } from "./fork-attachments";
import type { WebActor } from "@/chat/actor";
import { botConfig } from "@/chat/config";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import {
  juniorConversationAnnotations,
  juniorConversationEvents,
  juniorConversations,
} from "@/db/schema";
import { withConversationMutationLock } from "./sql/store";
import {
  createConversationId,
  recordWebConversationActivity,
} from "./web-input";

/** An expected request cannot produce a usable Conversation fork. */
export class ConversationForkError extends Error {}

/** Copy a completed reply's event prefix into an idle, independent web Conversation. */
export async function forkConversation(args: {
  actor: WebActor;
  attachmentStorage: AttachmentStorage;
  conversationId: string;
  messageSeq: number;
  idempotencyKey: string;
  visibility: "private" | "public";
}): Promise<{ conversationId: string; prefill: string }> {
  if (!args.actor.email) throw new Error("Web Actor requires a verified email");
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
  const writtenKeys: string[] = [];
  try {
    return await withConversationMutationLock(
      executor,
      args.conversationId,
      async () => {
        const source = await getConversationStore().get({
          conversationId: args.conversationId,
        });
        if (!source || source.transcriptPurgedAtMs !== undefined) {
          throw new ConversationForkError(
            "Conversation history is no longer available.",
          );
        }
        const events = await getConversationEventStore().loadHistory(
          args.conversationId,
        );
        const selected = events.find((event) => event.seq === args.messageSeq);
        if (
          selected?.data.type !== "message" ||
          !["assistant", "user"].includes(selected.data.role)
        ) {
          throw new ConversationForkError(
            "Select a user or assistant message.",
          );
        }
        const prefill = selected.data.role === "user" ? selected.data.text : "";
        const boundary =
          selected.data.role === "assistant"
            ? selected
            : events
                .filter(
                  (event) =>
                    event.seq < selected.seq &&
                    event.data.type === "message" &&
                    event.data.role === "assistant",
                )
                .at(-1);
        // A first user message forks an empty history and stays in the composer.
        const throughSeq = boundary?.seq ?? -1;
        const prefix = events.filter((event) => event.seq <= throughSeq);
        if (boundary) {
          const activeHistory = prefix.filter(
            (event) => event.historyVersion === boundary.historyVersion,
          );
          const { messages, seqs } = projectConversationEvents(activeHistory, {
            defaultProfile: botConfig.defaultProfile,
          });
          const previousReplySeq =
            prefix
              .filter(
                (event) =>
                  event.seq < boundary.seq &&
                  event.data.type === "message" &&
                  event.data.role === "assistant",
              )
              .at(-1)?.seq ?? -1;
          const tail = messages.at(-1);
          const pending = new Set<string>();
          for (const message of messages) {
            if (message.role === "assistant") {
              for (const part of message.content) {
                if (part.type === "toolCall") pending.add(part.id);
              }
            } else if (message.role === "toolResult") {
              pending.delete(message.toolCallId);
            }
          }
          if (
            (seqs.at(-1) ?? -1) <= previousReplySeq ||
            tail?.role !== "assistant" ||
            tail.content.some((part) => part.type === "toolCall") ||
            pending.size > 0 ||
            tail.stopReason === "error" ||
            tail.stopReason === "aborted"
          ) {
            throw new ConversationForkError(
              "This reply has no completed agent history to fork.",
            );
          }
        }
        return withConversationMutationLock(
          executor,
          conversationId,
          async () => {
            if (await getConversationStore().get({ conversationId }))
              return { conversationId, prefill };
            await recordWebConversationActivity({
              actor: args.actor,
              conversationId,
              nowMs: Date.now(),
              rootVisibility: args.visibility,
            });
            await getDb()
              .update(juniorConversations)
              .set({ title: source.title ?? null })
              .where(eq(juniorConversations.conversationId, conversationId));
            const sourceRows = await getDb()
              .select()
              .from(juniorConversationEvents)
              .where(
                and(
                  eq(
                    juniorConversationEvents.conversationId,
                    args.conversationId,
                  ),
                  lte(juniorConversationEvents.seq, throughSeq),
                ),
              )
              .orderBy(asc(juniorConversationEvents.seq));
            const rows = await copyForkAttachments({
              sourceConversationId: args.conversationId,
              conversationId,
              rows: sourceRows,
              storage: args.attachmentStorage,
              writtenKeys,
            });
            // Preserve sequence, history versions, timestamps, provenance, and encoded
            // model messages. No mailbox, lease, watch, or credential authority is copied.
            for (let offset = 0; offset < rows.length; offset += 100) {
              await getDb()
                .insert(juniorConversationEvents)
                .values(
                  rows
                    .slice(offset, offset + 100)
                    .map((row) => ({ ...row, conversationId })),
                );
            }
            const annotations = await getDb()
              .select()
              .from(juniorConversationAnnotations)
              .where(
                eq(
                  juniorConversationAnnotations.conversationId,
                  args.conversationId,
                ),
              );
            if (annotations.length) {
              await getDb()
                .insert(juniorConversationAnnotations)
                .values(annotations.map((row) => ({ ...row, conversationId })));
            }
            return { conversationId, prefill };
          },
        );
      },
    );
  } catch (error) {
    if (writtenKeys.length) await args.attachmentStorage.delete(writtenKeys);
    throw error;
  }
}
