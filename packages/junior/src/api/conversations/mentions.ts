import { loadConversationSlackTenantIds } from "@/chat/conversations/sql/event-actor";
import type { JuniorSqlDatabase } from "@/db/db";
import { resolveMentions, type MentionSource } from "../mentions";
import type {
  ActorIdentity,
  ConversationActivityPreview,
  ConversationReportEvent,
} from "../schema/conversation";

/** Text in one event that the dashboard renders with mentions. */
function eventMentionTexts(
  data: ConversationReportEvent["data"],
): MentionSource["texts"] {
  switch (data.type) {
    case "message":
      return data.redacted
        ? []
        : [
            data.text,
            data.trustedSummary,
            ...(data.events ?? []).map((event) => event.trustedSummary),
          ];
    case "assistant_message":
      return data.parts.map((part) => part.text);
    case "compaction":
      return [data.summary];
    case "structured_event":
      return [
        data.presentation.preview,
        ...(data.presentation.details ?? []).map(
          (detail) => detail.description,
        ),
      ];
    default:
      return [];
  }
}

function withMentions<T extends object>(
  value: T,
  mentions: ActorIdentity[],
): T & { mentions?: ActorIdentity[] } {
  return mentions.length > 0 ? { ...value, mentions } : value;
}

/**
 * Attach the people that each event and the summary of one conversation
 * mention, resolved at read time.
 */
export async function attachConversationMentions(
  executor: JuniorSqlDatabase,
  conversationId: string,
  content: { events: ConversationReportEvent[]; summary?: string },
): Promise<{
  events: ConversationReportEvent[];
  summaryMentions: ActorIdentity[];
}> {
  const tenantId = (
    await loadConversationSlackTenantIds(executor, [conversationId])
  ).get(conversationId);
  const sources: MentionSource[] = content.events.map((event) => ({
    tenantId,
    texts: eventMentionTexts(event.data),
  }));
  if (content.summary) {
    sources.push({ tenantId, texts: [content.summary] });
  }
  const mentions = await resolveMentions(executor, sources);
  return {
    events: content.events.map((event, index) =>
      withMentions(event, mentions[index]!),
    ),
    summaryMentions: content.summary ? mentions.at(-1)! : [],
  };
}

/**
 * Attach the people that each activity preview mentions, resolved at read
 * time. `tenants` holds the Slack workspace of each conversation, which the
 * feed already read with its rows.
 */
export async function attachActivityPreviewMentions(
  executor: JuniorSqlDatabase,
  previews: ReadonlyMap<string, ConversationActivityPreview>,
  tenants: ReadonlyMap<string, string>,
): Promise<Map<string, ConversationActivityPreview>> {
  const entries = [...previews];
  const mentions = await resolveMentions(
    executor,
    entries.map(([conversationId, preview]) => ({
      tenantId: tenants.get(conversationId),
      texts: [preview.text],
    })),
  );
  return new Map(
    entries.map(([conversationId, preview], index) => [
      conversationId,
      withMentions(preview, mentions[index]!),
    ]),
  );
}
