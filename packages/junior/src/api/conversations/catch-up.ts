import type { User } from "@sentry/junior-plugin-api";
import type { ConversationReportEvent } from "@/api/schema/conversation";
import { briefEntriesFromReportEvents } from "@/chat/briefs/event-entries";
import { readConversationBriefThrough } from "@/chat/briefs/store";
import { generateCatchUp } from "@/chat/catch-up/generate";
import { botConfig } from "@/chat/config";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { completeText } from "@/chat/pi/client";
import { throwApiError } from "../http";
import type {
  ConversationCatchUp,
  ConversationCatchUpBody,
} from "../schema/conversation-catch-up";
import { readConversationAccessFromSql } from "./access";
import { readConversationEventPage } from "./event-page";

const EVENT_PAGE_SIZE = 250;
// The model keeps only the newest rows that fit its input, so rows older
// than this would be read and then dropped.
const MAX_EVENTS = 1_000;

async function readUnreadEvents(
  conversationId: string,
  range: ConversationCatchUpBody,
): Promise<{ events: ConversationReportEvent[]; omittedEarlierRows: boolean }> {
  const pages: ConversationReportEvent[][] = [];
  let count = 0;
  let beforeSeq: number | undefined = range.throughSeq + 1;
  while (beforeSeq !== undefined && beforeSeq > range.afterSeq + 1) {
    const page = await readConversationEventPage(getSqlExecutor(), {
      beforeSeq,
      canExposePayload: true,
      conversationId,
      limit: EVENT_PAGE_SIZE,
    });
    const unread = page.events.filter((event) => event.seq > range.afterSeq);
    pages.unshift(unread);
    count += unread.length;
    if (unread.length < page.events.length) break;
    if (count >= MAX_EVENTS) {
      return { events: pages.flat(), omittedEarlierRows: true };
    }
    beforeSeq = page.previousSeq;
  }
  return { events: pages.flat(), omittedEarlierRows: false };
}

/**
 * Summarize what happened in one Conversation after the viewer's read
 * position. It runs only on request, because each reader stops at a different
 * place and nothing is stored to share.
 */
export async function catchUpOnConversation(
  viewer: User,
  conversationId: string,
  range: ConversationCatchUpBody,
): Promise<ConversationCatchUp> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.canViewPrivateContent) {
    throwApiError(403, "You do not have access to this conversation.");
  }

  const [{ events, omittedEarlierRows }, brief] = await Promise.all([
    readUnreadEvents(conversationId, range),
    readConversationBriefThrough(getDb(), conversationId, range.afterSeq),
  ]);
  const entries = briefEntriesFromReportEvents(events);
  if (entries.length === 0) {
    throwApiError(404, "No unread messages to summarize.");
  }

  return await generateCatchUp({
    ...(brief ? { brief: brief.content } : undefined),
    completeText,
    conversationId,
    entries,
    modelId: botConfig.fastModelId,
    omittedEarlierRows,
    reader: {
      email: viewer.email,
      ...(viewer.displayName ? { name: viewer.displayName } : undefined),
    },
    ...(conversation.title ? { title: conversation.title } : undefined),
  });
}
