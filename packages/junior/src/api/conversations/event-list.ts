import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import { readConversationAccessFromSql } from "./access";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import {
  readConversationEventPage,
  readConversationEventPageAfter,
  readConversationEventPageAround,
} from "./event-page";
import { attachConversationMentions } from "./mentions";
import { readConversationRecordFromSql } from "./list";
import { conversationEventHistory } from "./projection";
import { throwApiError } from "../http";
import {
  conversationEventPageSchema,
  type ConversationEventPage,
} from "../schema/conversation";

/** Read one bounded page of reporting events before, after, or around a signed cursor. */
export async function readConversationEvents(
  conversationId: string,
  boundary: { after: string } | { around: string } | { before: string },
  options: {
    limit?: number;
    viewer?: User;
  } = {},
): Promise<ConversationEventPage | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const cursor = decodeConversationCursor({
    conversationId,
    cursor:
      "after" in boundary
        ? boundary.after
        : "around" in boundary
          ? boundary.around
          : boundary.before,
  });
  if (!cursor) throwApiError(400, "Invalid conversation cursor.");

  const accessByConversation = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    options.viewer,
  );
  const access = accessByConversation.get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;
  const transcriptPurgedAtMs = record.conversation.transcriptPurgedAtMs;
  const pageArgs = {
    canExposePayload,
    conversationId,
    limit: options.limit ?? 500,
  };
  const page: Awaited<ReturnType<typeof readConversationEventPageAround>> =
    transcriptPurgedAtMs !== undefined
      ? { events: [] }
      : "after" in boundary
        ? await readConversationEventPageAfter(getSqlExecutor(), {
            ...pageArgs,
            afterSeq: cursor.seq,
          })
        : "around" in boundary
          ? await readConversationEventPageAround(getSqlExecutor(), {
              ...pageArgs,
              seq: cursor.seq,
            })
          : await readConversationEventPage(getSqlExecutor(), {
              ...pageArgs,
              beforeSeq: cursor.seq,
            });
  const cursorAt = (seq: number) =>
    encodeConversationCursor({ conversationId, seq });

  return conversationEventPageSchema.parse({
    events: (
      await attachConversationMentions(getSqlExecutor(), conversationId, {
        events: page.events,
      })
    ).events,
    eventHistory: conversationEventHistory({
      canExposePayload,
      ...(transcriptPurgedAtMs === undefined
        ? undefined
        : { transcriptPurgedAtMs }),
    }),
    ...(page.previousSeq === undefined
      ? undefined
      : { previousCursor: cursorAt(page.previousSeq) }),
    ...(page.nextSeq === undefined
      ? undefined
      : { nextCursor: cursorAt(page.nextSeq) }),
    generatedAt: new Date().toISOString(),
  });
}
