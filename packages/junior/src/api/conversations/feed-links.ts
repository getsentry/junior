import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { CONVERSATION_FEED_LINK_LIMIT } from "@/api/schema/conversation-feed";
import { parseDashboardConversationLink } from "@/chat/dashboard-link";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorAttachments,
  juniorConversations,
  juniorMessageAttachments,
} from "@/db/schema";
import { safeLinkUrl } from "@/net/link-url";

// A row reads the newest uses of links in its Conversation, keeps each link
// once, and looks up only the newest few. The row drops links it already
// shows (its Annotations and a link back to itself) after, so it reads a
// few more than it shows.
const RECENT_USE_LIMIT = 20;
const CANDIDATE_LINK_LIMIT = CONVERSATION_FEED_LINK_LIMIT + 3;

/** The URLs that a row's Annotations already show, as links compare them. */
export function annotationUrls(
  annotations: ReadonlyArray<{ url?: string | null }> | undefined,
): Set<string> {
  return new Set(
    (annotations ?? []).flatMap(({ url }) => {
      const href = safeLinkUrl(url);
      return href ? [href] : [];
    }),
  );
}

/** The links a feed row shows, from its `feedLinksSql` candidates. */
export function pickFeedLinks(
  conversationId: string,
  urls: readonly string[],
  shown: ReadonlySet<string>,
): string[] {
  const links: string[] = [];
  for (const link of urls) {
    const href = safeLinkUrl(link);
    if (
      !href ||
      links.includes(href) ||
      shown.has(href) ||
      // A dashboard link back to the same Conversation names nothing new.
      parseDashboardConversationLink(href) === conversationId
    ) {
      continue;
    }
    links.push(href);
    if (links.length >= CONVERSATION_FEED_LINK_LIMIT) break;
  }
  return links;
}

/**
 * A feed row column with the newest distinct links of its Conversation,
 * newest message first and in text order within a message, or null. It is
 * a scalar subquery on the row read, so links cost no round trip of their
 * own. Links are private content: show them only where the viewer sees
 * private content. Only URLs leave the database, never message text.
 */
export function feedLinksSql(db: JuniorDatabase): SQL<string[] | null> {
  const m = juniorMessageAttachments;
  const recentUses = db
    .select({ attachmentId: m.attachmentId, position: m.position, seq: m.seq })
    .from(m)
    .where(eq(m.conversationId, juniorConversations.conversationId))
    .orderBy(desc(m.seq), asc(m.position))
    .limit(RECENT_USE_LIMIT)
    .as("recent_uses");
  // The newest use of each link.
  const distinctUses = db
    .selectDistinctOn([recentUses.attachmentId], {
      attachmentId: recentUses.attachmentId,
      position: recentUses.position,
      seq: recentUses.seq,
    })
    .from(recentUses)
    .orderBy(
      recentUses.attachmentId,
      desc(recentUses.seq),
      asc(recentUses.position),
    )
    .as("distinct_uses");
  const candidates = db
    .select({
      attachmentId: distinctUses.attachmentId,
      position: distinctUses.position,
      seq: distinctUses.seq,
    })
    .from(distinctUses)
    .orderBy(desc(distinctUses.seq), asc(distinctUses.position))
    .limit(CANDIDATE_LINK_LIMIT)
    .as("candidate_uses");
  const urls = db
    .select({
      urls: sql`array_agg(${juniorAttachments.url} order by ${candidates.seq} desc, ${candidates.position})`,
    })
    .from(candidates)
    .innerJoin(
      juniorAttachments,
      and(
        eq(juniorAttachments.id, candidates.attachmentId),
        isNotNull(juniorAttachments.url),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
  return sql<string[] | null>`(${urls})`;
}
