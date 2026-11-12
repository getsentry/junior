import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { CONVERSATION_FEED_LINK_LIMIT } from "@/api/schema/conversation-feed";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";

// Links come from each Conversation's newest messages only, so a page reads
// a bounded number of rows through the (conversation, type, seq) index.
const RECENT_MESSAGE_LIMIT = 50;
// Slack wraps links as <url|label>, and Markdown as (url), so the match
// stops at those delimiters. Trailing punctuation is trimmed after.
const URL_PATTERN = String.raw`https?://[^\s<>|"'\x60]+`;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}*_~]+$/;

function cleanUrl(match: string): string | undefined {
  const trimmed = match.replace(TRAILING_PUNCTUATION, "");
  if (!URL.canParse(trimmed)) return undefined;
  const url = new URL(trimmed);
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.href
    : undefined;
}

// A dashboard link back to the same Conversation names nothing new.
function linksToConversation(href: string, conversationId: string): boolean {
  const match = /^\/conversations\/([^/]+)\/?$/.exec(new URL(href).pathname);
  if (!match) return false;
  try {
    return decodeURIComponent(match[1]!) === conversationId;
  } catch {
    return false;
  }
}

/** The URLs that a row's Annotations already show, as links compare them. */
export function annotationUrls(
  annotations: ReadonlyArray<{ url?: string | null }> | undefined,
): Set<string> {
  return new Set(
    (annotations ?? []).flatMap(({ url }) => {
      const href = url ? cleanUrl(url) : undefined;
      return href ? [href] : [];
    }),
  );
}

/**
 * Read up to three distinct web links from each Conversation's newest
 * messages, newest first, in one query. Pass only the Conversations whose
 * private content the viewer can see, each with the URLs its row already
 * shows, such as its Annotations. Only URLs leave the database.
 */
export async function readFeedLinks(
  db: JuniorDatabase,
  conversations: ReadonlyArray<{
    conversationId: string;
    shownUrls: ReadonlySet<string>;
  }>,
): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();
  if (conversations.length === 0) return links;
  const text = sql`${juniorConversationEvents.payload}->>'text'`;
  const recent = db
    .select({
      seq: juniorConversationEvents.seq,
      urls: sql<
        string[]
      >`array(select match[1] from regexp_matches(${text}, ${URL_PATTERN}, 'g') as match)`.as(
        "urls",
      ),
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationEvents.type, "message"),
        // Channel messages that did not mention Junior stay out, as in the
        // transcript.
        sql`coalesce(${juniorConversationEvents.payload}->'meta'->>'explicitMention', 'true') <> 'false'`,
      ),
    )
    .orderBy(desc(juniorConversationEvents.seq))
    .limit(RECENT_MESSAGE_LIMIT)
    .as("recent");
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      urls: recent.urls,
    })
    .from(juniorConversations)
    .innerJoinLateral(recent, sql`true`)
    .where(
      and(
        inArray(
          juniorConversations.conversationId,
          conversations.map(({ conversationId }) => conversationId),
        ),
        sql`cardinality(${recent.urls}) > 0`,
      ),
    )
    .orderBy(juniorConversations.conversationId, desc(recent.seq));
  const shownById = new Map(
    conversations.map(({ conversationId, shownUrls }) => [
      conversationId,
      shownUrls,
    ]),
  );
  for (const { conversationId, urls } of rows) {
    const list = links.get(conversationId) ?? [];
    if (list.length >= CONVERSATION_FEED_LINK_LIMIT) continue;
    const shown = shownById.get(conversationId);
    for (const match of urls) {
      const href = cleanUrl(match);
      if (
        !href ||
        list.includes(href) ||
        shown?.has(href) ||
        linksToConversation(href, conversationId)
      ) {
        continue;
      }
      list.push(href);
      if (list.length >= CONVERSATION_FEED_LINK_LIMIT) break;
    }
    if (list.length > 0) links.set(conversationId, list);
  }
  return links;
}
