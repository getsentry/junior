import type { User } from "@sentry/junior-plugin-api";
import { and, eq, exists, inArray, or, sql, type SQL } from "drizzle-orm";
import { webActorFromEmail } from "@/chat/api-turns/work";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";

/** Collect durable message author ids that identify one signed-in viewer. */
export async function resolveViewerMessageAuthorIds(
  db: JuniorDatabase,
  viewer: User,
): Promise<string[]> {
  const email = viewer.email.trim().toLowerCase();
  const authorIds = new Set<string>([webActorFromEmail(email).userId]);
  if (email) {
    authorIds.add(email);
  }

  const identities = await db
    .select({
      providerSubjectId: juniorIdentities.providerSubjectId,
    })
    .from(juniorIdentities)
    .where(eq(juniorIdentities.userId, viewer.id));
  for (const identity of identities) {
    const subjectId = identity.providerSubjectId.trim();
    if (subjectId) {
      authorIds.add(subjectId);
    }
  }

  return [...authorIds].filter(Boolean);
}

/** Collect durable message author ids for one normalized actor email. */
export async function resolveEmailMessageAuthorIds(
  db: JuniorDatabase,
  email: string,
): Promise<string[]> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];
  const authorIds = new Set<string>([
    normalized,
    webActorFromEmail(normalized).userId,
  ]);

  const identities = await db
    .select({
      providerSubjectId: juniorIdentities.providerSubjectId,
    })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.emailNormalized, normalized),
        eq(juniorIdentities.emailVerified, true),
      ),
    );
  for (const identity of identities) {
    const subjectId = identity.providerSubjectId.trim();
    if (subjectId) {
      authorIds.add(subjectId);
    }
  }

  return [...authorIds].filter(Boolean);
}

/**
 * True when the conversation has a durable human user message authored by one
 * of the supplied identity keys (Slack user id, dashboard author id, or email).
 */
export function conversationHasUserMessageByAuthors(
  authorIds: readonly string[],
): SQL | undefined {
  if (authorIds.length === 0) return undefined;

  const authoredUserMessage = getDb()
    .select({ conversationId: juniorConversationEvents.conversationId })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          juniorConversations.conversationId,
        ),
        inArray(juniorConversationEvents.type, ["message", "message_updated"]),
        sql`${juniorConversationEvents.payload}->>'role' = 'user'`,
        sql`coalesce((${juniorConversationEvents.payload}->'meta'->'author'->>'isBot')::boolean, false) = false`,
        inArray(
          sql<string>`${juniorConversationEvents.payload}->'meta'->'author'->>'userId'`,
          [...authorIds],
        ),
      ),
    );

  return exists(authoredUserMessage);
}

/** Find which of the supplied conversations include a human user message by author. */
export async function conversationIdsWithUserMessageByAuthors(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  authorIds: readonly string[],
): Promise<Set<string>> {
  if (conversationIds.length === 0 || authorIds.length === 0) {
    return new Set();
  }

  const rows = await db
    .selectDistinct({
      conversationId: juniorConversationEvents.conversationId,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        inArray(juniorConversationEvents.conversationId, [...conversationIds]),
        inArray(juniorConversationEvents.type, ["message", "message_updated"]),
        sql`${juniorConversationEvents.payload}->>'role' = 'user'`,
        sql`coalesce((${juniorConversationEvents.payload}->'meta'->'author'->>'isBot')::boolean, false) = false`,
        inArray(
          sql<string>`${juniorConversationEvents.payload}->'meta'->'author'->>'userId'`,
          [...authorIds],
        ),
      ),
    );

  return new Set(rows.map((row) => row.conversationId));
}

/** Root-actor ownership or a durable human user message by the same person. */
export function viewerConversationMembership(args: {
  actorMatch: SQL | undefined;
  authorIds: readonly string[];
}): SQL | undefined {
  const messageMatch = conversationHasUserMessageByAuthors(args.authorIds);
  if (args.actorMatch && messageMatch) {
    return or(args.actorMatch, messageMatch);
  }
  return args.actorMatch ?? messageMatch;
}
