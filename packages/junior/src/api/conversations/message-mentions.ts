import { and, eq, inArray } from "drizzle-orm";
import { loadConversationSlackTenantId } from "@/chat/conversations/sql/event-actor";
import { lookupSlackUser } from "@/chat/slack/user";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import type {
  ActorIdentity,
  ConversationReportEvent,
} from "../schema/conversation";

// Message text keeps Slack user mentions as `<@U123>` or `<@U123|label>`.
const SLACK_USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/g;

function mentionedSlackUserIds(text: string | undefined): string[] {
  if (!text) return [];
  return [
    ...new Set([...text.matchAll(SLACK_USER_MENTION_RE)].map((m) => m[1]!)),
  ];
}

function messageMentionText(
  data: Extract<ConversationReportEvent["data"], { type: "message" }>,
): string {
  return [
    data.text,
    data.trustedSummary,
    ...(data.events ?? []).map((event) => event.trustedSummary),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Read current names for mentioned Slack users. Known Junior identities come
 * first. The email is set only for a linked, verified Junior user, because
 * that email is the People profile route.
 */
async function resolveSlackMentions(
  executor: JuniorSqlDatabase,
  conversationId: string,
  userIds: string[],
): Promise<Map<string, ActorIdentity>> {
  const tenantId = await loadConversationSlackTenantId(
    executor,
    conversationId,
  );
  const rows = await executor
    .db()
    .select({
      displayName: juniorIdentities.displayName,
      emailVerified: juniorIdentities.emailVerified,
      handle: juniorIdentities.handle,
      providerSubjectId: juniorIdentities.providerSubjectId,
      userDisplayName: juniorUsers.displayName,
      userEmail: juniorUsers.primaryEmail,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        inArray(juniorIdentities.providerSubjectId, userIds),
        tenantId ? eq(juniorIdentities.providerTenantId, tenantId) : undefined,
      ),
    );

  const people = new Map<string, ActorIdentity>();
  for (const row of rows) {
    if (people.has(row.providerSubjectId)) continue;
    const fullName = row.userDisplayName?.trim() || row.displayName?.trim();
    const email = row.emailVerified ? row.userEmail?.trim() : undefined;
    people.set(row.providerSubjectId, {
      slackUserId: row.providerSubjectId,
      ...(fullName ? { fullName } : undefined),
      ...(row.handle ? { slackUserName: row.handle } : undefined),
      ...(email ? { email } : undefined),
    });
  }

  // Ask Slack for a name when Junior has none. Keep any known profile email.
  const unnamed = userIds.filter((id) => {
    const person = people.get(id);
    return !person?.fullName && !person?.slackUserName;
  });
  if (tenantId && unnamed.length > 0) {
    const profiles = await Promise.all(
      unnamed.map((id) => lookupSlackUser(tenantId, id)),
    );
    unnamed.forEach((id, index) => {
      const profile = profiles[index];
      if (!profile?.fullName && !profile?.userName) return;
      people.set(id, {
        ...people.get(id),
        slackUserId: id,
        ...(profile.fullName ? { fullName: profile.fullName } : undefined),
        ...(profile.userName ? { slackUserName: profile.userName } : undefined),
      });
    });
  }
  return people;
}

/** Attach the people that each visible message mentions, resolved at read time. */
export async function attachMessageMentions(
  executor: JuniorSqlDatabase,
  conversationId: string,
  events: ConversationReportEvent[],
): Promise<ConversationReportEvent[]> {
  const idsByIndex = events.map((event) =>
    event.data.type === "message" && !event.data.redacted
      ? mentionedSlackUserIds(messageMentionText(event.data))
      : [],
  );
  const allIds = [...new Set(idsByIndex.flat())];
  if (allIds.length === 0) return events;

  const people = await resolveSlackMentions(executor, conversationId, allIds);
  return events.map((event, index) => {
    if (event.data.type !== "message") return event;
    const mentions = idsByIndex[index]!.flatMap((id) => {
      const person = people.get(id);
      return person ? [person] : [];
    });
    return mentions.length > 0
      ? { ...event, data: { ...event.data, mentions } }
      : event;
  });
}
