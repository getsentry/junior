import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import { readConversationAccessFromSql } from "./access";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import { readConversationEventPage } from "./event-page";
import { readConversationRecordFromSql } from "./list";
import { conversationEventHistory } from "./projection";
import { throwApiError } from "../http";
import {
  conversationEventPageSchema,
  type ConversationEventPage,
} from "../schema/conversation";

/** Read one bounded page of reporting events before a signed cursor. */
export async function readConversationEvents(
  conversationId: string,
  beforeValue: string,
  options: {
    limit?: number;
    viewer?: User;
  } = {},
): Promise<ConversationEventPage | undefined> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) return undefined;

  const before = decodeConversationCursor({
    conversationId,
    cursor: beforeValue,
  });
  if (!before) throwApiError(400, "Invalid conversation cursor.");

  const accessByConversation = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    options.viewer,
  );
  const access = accessByConversation.get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;
  const transcriptPurgedAtMs = record.conversation.transcriptPurgedAtMs;
  const page =
    transcriptPurgedAtMs === undefined
      ? await readConversationEventPage(getSqlExecutor(), {
          beforeSeq: before.seq,
          canExposePayload,
          conversationId,
          limit: options.limit ?? 500,
        })
      : { events: [] };

  return conversationEventPageSchema.parse({
    events: page.events,
    eventHistory: conversationEventHistory({
      canExposePayload,
      ...(transcriptPurgedAtMs === undefined ? undefined : { transcriptPurgedAtMs }),
    }),
    ...(page.previousSeq === undefined
      ? undefined
      : {
          previousCursor: encodeConversationCursor({
            conversationId,
            seq: page.previousSeq,
          }),
        }),
    generatedAt: new Date().toISOString(),
  });
}
