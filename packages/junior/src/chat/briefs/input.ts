import { and, arrayContains, eq, isNotNull } from "drizzle-orm";
import type { ConversationReportEvent } from "@/api/schema/conversation";
import { readConversationEventPage } from "@/api/conversations/event-page";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
import { briefEntriesFromReportEvents } from "./event-entries";
import { parseBriefInput, type BriefInput } from "./schema";

const EVENT_PAGE_SIZE = 500;

async function readReportEventsThrough(
  executor: JuniorSqlDatabase,
  conversationId: string,
  throughSeq: number,
): Promise<ConversationReportEvent[]> {
  const pages: ConversationReportEvent[][] = [];
  let beforeSeq: number | undefined = throughSeq + 1;
  do {
    const page = await readConversationEventPage(executor, {
      beforeSeq,
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

/**
 * Build generator input from SQL through one durable event. The caller owns
 * the boundary, so a Turn that completes during the read cannot be covered by
 * a Brief that never saw it.
 */
export async function briefInputFromSql(
  executor: JuniorSqlDatabase,
  conversationId: string,
  throughSeq: number,
): Promise<BriefInput> {
  const db = executor.db();
  const conversation = await createSqlStore(executor).get({ conversationId });
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} is unavailable`);
  }
  const [events, annotations, codeChanges] = await Promise.all([
    readReportEventsThrough(executor, conversationId, throughSeq),
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
  ]);
  const location = conversation.location;
  return parseBriefInput({
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
}
