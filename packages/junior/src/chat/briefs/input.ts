import { and, arrayContains, eq, isNotNull, max } from "drizzle-orm";
import type { ConversationReportEvent } from "@/api/schema/conversation";
import { readConversationEventPage } from "@/api/conversations/event-page";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorConversationEvents,
} from "@/db/schema";
import { briefEntriesFromReportEvents } from "./event-entries";
import { parseBriefInput, type BriefInput } from "./schema";

const EVENT_PAGE_SIZE = 500;

async function readAllReportEvents(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<ConversationReportEvent[]> {
  const pages: ConversationReportEvent[][] = [];
  let beforeSeq: number | undefined;
  do {
    const page = await readConversationEventPage(executor, {
      ...(beforeSeq !== undefined ? { beforeSeq } : undefined),
      canExposePayload: true,
      conversationId,
      limit: EVENT_PAGE_SIZE,
    });
    pages.unshift(page.events);
    beforeSeq = page.previousSeq;
  } while (beforeSeq !== undefined);

  const bySequence = new Map<number, ConversationReportEvent>();
  for (const event of pages.flat()) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

/** Build generator input and its durable event boundary from SQL. */
export async function briefInputFromSql(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<{ input: BriefInput; throughSeq: number }> {
  const db = executor.db();
  const conversation = await createSqlStore(executor).get({ conversationId });
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} is unavailable`);
  }
  const [events, annotations, codeChanges, sequenceRows] = await Promise.all([
    readAllReportEvents(executor, conversationId),
    listConversationAnnotations(db, conversationId),
    db
      .select({
        closedAt: juniorCodeChanges.closedAt,
        mergedAt: juniorCodeChanges.mergedAt,
        number: juniorCodeChanges.number,
        openedAt: juniorCodeChanges.openedAt,
        repository: juniorCodeRepositories.name,
        state: juniorCodeChanges.state,
        title: juniorCodeChanges.title,
        url: juniorCodeChanges.url,
      })
      .from(juniorCodeChanges)
      .innerJoin(
        juniorCodeRepositories,
        eq(juniorCodeRepositories.id, juniorCodeChanges.repositoryId),
      )
      .where(
        and(
          arrayContains(juniorCodeChanges.conversationIds, [conversationId]),
          isNotNull(juniorCodeChanges.url),
        ),
      ),
    db
      .select({ seq: max(juniorConversationEvents.seq) })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, conversationId)),
  ]);
  const throughSeq = sequenceRows[0]?.seq;
  if (throughSeq === null || throughSeq === undefined) {
    throw new Error(`Conversation ${conversationId} has no durable events`);
  }
  const location = conversation.location;
  const input = parseBriefInput({
    conversationId,
    ...(conversation.title ? { title: conversation.title } : undefined),
    visibility: conversation.visibility ?? "private",
    ...(location
      ? {
          location: {
            provider: location.provider,
            ...(conversation.channelName
              ? { channelName: conversation.channelName }
              : undefined),
          },
        }
      : undefined),
    entries: briefEntriesFromReportEvents(events),
    codeChanges: codeChanges.map((change) => ({
      repository: change.repository,
      number: change.number,
      ...(change.title ? { title: change.title } : undefined),
      url: change.url!,
      state: change.state,
      openedAt: change.openedAt.toISOString(),
      ...(change.mergedAt
        ? { mergedAt: change.mergedAt.toISOString() }
        : undefined),
      ...(change.closedAt
        ? { closedAt: change.closedAt.toISOString() }
        : undefined),
    })),
    resources: annotations.map((annotation) => ({
      label: annotation.label,
      url: annotation.url,
      ...(annotation.status ? { status: annotation.status } : undefined),
    })),
  });
  return { input, throughSeq };
}
