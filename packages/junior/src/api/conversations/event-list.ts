import { getDb, getSqlExecutor } from "@/chat/db";
import { readConversationAccessFromSql } from "./access";
import { decodeConversationCursor, encodeConversationCursor } from "./cursor";
import { readConversationEventPage } from "./event-page";
import { readConversationRecordFromSql } from "./list";
import { conversationEventHistory } from "./projection";
import { parseParams, parseQuery, throwApiError } from "../http";
import { defineApiRoute } from "../route";
import { getViewer } from "../viewer";
import {
  conversationEventPageSchema,
  conversationEventsQuerySchema,
  conversationParamsSchema,
  type ConversationEventPage,
} from "../schema/conversation";

/** Read one bounded page of reporting events before a signed cursor. */
export async function readConversationEvents(
  conversationId: string,
  beforeValue: string,
  options: {
    limit?: number;
    verifiedViewerEmail?: string;
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
    options.verifiedViewerEmail,
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
      ...(transcriptPurgedAtMs === undefined ? {} : { transcriptPurgedAtMs }),
    }),
    ...(page.previousSeq === undefined
      ? {}
      : {
          previousCursor: encodeConversationCursor({
            conversationId,
            seq: page.previousSeq,
          }),
        }),
    generatedAt: new Date().toISOString(),
  });
}

export default defineApiRoute({
  method: "get",
  path: "/:conversationId/events",
  responseSchema: conversationEventPageSchema,
  handler: async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const { before, limit } = parseQuery(
      conversationEventsQuerySchema,
      c.req.query(),
    );
    const viewer = getViewer(c);
    const report = await readConversationEvents(conversationId, before, {
      limit,
      ...(viewer ? { verifiedViewerEmail: viewer.email } : {}),
    });
    if (!report) throwApiError(404, "Conversation not found.");
    return report;
  },
});
