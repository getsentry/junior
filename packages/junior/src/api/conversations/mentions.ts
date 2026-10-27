import type { ConversationBrief } from "@/chat/briefs/schema";
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
    case "handoff":
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

function briefMentionTexts(brief: ConversationBrief): MentionSource["texts"] {
  return [
    brief.summary,
    brief.intent,
    brief.outcome.text,
    ...brief.decisions.flatMap((decision) => [decision.text, decision.by]),
    ...brief.openDecisions.flatMap((decision) => [
      decision.text,
      decision.owner,
    ]),
    ...brief.facts,
  ];
}

function withMentions<T extends object>(
  value: T,
  mentions: ActorIdentity[],
): T & { mentions?: ActorIdentity[] } {
  return mentions.length > 0 ? { ...value, mentions } : value;
}

/**
 * Attach the people that each event and the Brief of one conversation
 * mention, resolved at read time.
 */
export async function attachConversationMentions(
  executor: JuniorSqlDatabase,
  conversationId: string,
  content: { brief?: ConversationBrief; events: ConversationReportEvent[] },
): Promise<{
  briefMentions: ActorIdentity[];
  events: ConversationReportEvent[];
}> {
  const tenantId = (
    await loadConversationSlackTenantIds(executor, [conversationId])
  ).get(conversationId);
  const sources: MentionSource[] = content.events.map((event) => ({
    tenantId,
    texts: eventMentionTexts(event.data),
  }));
  if (content.brief) {
    sources.push({ tenantId, texts: briefMentionTexts(content.brief) });
  }
  const mentions = await resolveMentions(executor, sources);
  return {
    briefMentions: content.brief ? mentions.at(-1)! : [],
    events: content.events.map((event, index) =>
      withMentions(event, mentions[index]!),
    ),
  };
}

/** Attach the people that each activity preview mentions, resolved at read time. */
export async function attachActivityPreviewMentions(
  executor: JuniorSqlDatabase,
  previews: ReadonlyMap<string, ConversationActivityPreview>,
): Promise<Map<string, ConversationActivityPreview>> {
  const entries = [...previews];
  const tenants = await loadConversationSlackTenantIds(
    executor,
    entries.map(([conversationId]) => conversationId),
  );
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
