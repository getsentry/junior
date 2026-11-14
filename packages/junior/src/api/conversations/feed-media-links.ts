import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  CONVERSATION_FEED_LINK_LIMIT,
  CONVERSATION_FEED_MEDIA_LIMIT,
  type ConversationFeedMedia,
} from "@/api/schema/conversation-feed";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorAttachments,
  juniorConversationEvents,
  juniorConversations,
} from "@/db/schema";

/** Extra feed row content that a request asks for with `include=`. */
export type ConversationFeedInclude = "links" | "media";

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

function pickLinks(
  conversationId: string,
  urlsByMessage: readonly (readonly string[])[],
  shown: ReadonlySet<string>,
): string[] {
  const links: string[] = [];
  for (const match of urlsByMessage.flat()) {
    const href = cleanUrl(match);
    if (
      !href ||
      links.includes(href) ||
      shown.has(href) ||
      linksToConversation(href, conversationId)
    ) {
      continue;
    }
    links.push(href);
    if (links.length >= CONVERSATION_FEED_LINK_LIMIT) break;
  }
  return links;
}

/**
 * Read the newest stored files and the newest distinct web links of each
 * Conversation for its feed row, in one query. Each part is a lateral
 * subquery, and a part that `include` does not name never runs. Pass only
 * the Conversations whose private content the viewer can see, each with the
 * URLs its row already shows, such as its Annotations. Only file metadata
 * and URLs leave the database, never message text.
 */
export async function readFeedMediaAndLinks(
  db: JuniorDatabase,
  conversations: ReadonlyArray<{
    conversationId: string;
    shownUrls: ReadonlySet<string>;
  }>,
  include: ReadonlySet<ConversationFeedInclude>,
): Promise<{
  links: Map<string, string[]>;
  media: Map<string, ConversationFeedMedia[]>;
}> {
  const links = new Map<string, string[]>();
  const media = new Map<string, ConversationFeedMedia[]>();
  if (conversations.length === 0 || include.size === 0) {
    return { links, media };
  }
  // A literal `false` lets Postgres skip a part that is not asked for.
  const skip = (part: ConversationFeedInclude) =>
    include.has(part) ? undefined : sql`false`;

  const recentFiles = db
    .select({
      contentType: juniorAttachments.contentType,
      createdAt: juniorAttachments.createdAt,
      filename: juniorAttachments.filename,
      id: juniorAttachments.id,
    })
    .from(juniorAttachments)
    .where(
      and(
        eq(
          juniorAttachments.conversationId,
          juniorConversations.conversationId,
        ),
        isNull(juniorAttachments.deleteRequestedAt),
        skip("media"),
      ),
    )
    .orderBy(desc(juniorAttachments.createdAt), desc(juniorAttachments.id))
    .limit(CONVERSATION_FEED_MEDIA_LIMIT)
    .as("recent_files");
  const files = db
    .select({
      files: sql<
        ConversationFeedMedia[] | null
      >`jsonb_agg(jsonb_build_object('contentType', ${recentFiles.contentType}, 'filename', ${recentFiles.filename}, 'id', ${recentFiles.id}) order by ${recentFiles.createdAt} desc, ${recentFiles.id} desc)`.as(
        "files",
      ),
    })
    .from(recentFiles)
    .as("files");

  const text = sql`${juniorConversationEvents.payload}->>'text'`;
  const recentMessages = db
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
        skip("links"),
      ),
    )
    .orderBy(desc(juniorConversationEvents.seq))
    .limit(RECENT_MESSAGE_LIMIT)
    .as("recent_messages");
  const messageUrls = db
    .select({
      urls: sql<
        string[][] | null
      >`jsonb_agg(${recentMessages.urls} order by ${recentMessages.seq} desc) filter (where cardinality(${recentMessages.urls}) > 0)`.as(
        "urls",
      ),
    })
    .from(recentMessages)
    .as("message_urls");

  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      files: files.files,
      urls: messageUrls.urls,
    })
    .from(juniorConversations)
    .leftJoinLateral(files, sql`true`)
    .leftJoinLateral(messageUrls, sql`true`)
    .where(
      inArray(
        juniorConversations.conversationId,
        conversations.map(({ conversationId }) => conversationId),
      ),
    );
  const shownById = new Map(
    conversations.map(({ conversationId, shownUrls }) => [
      conversationId,
      shownUrls,
    ]),
  );
  for (const { conversationId, files: rowFiles, urls } of rows) {
    if (rowFiles?.length) media.set(conversationId, rowFiles);
    const picked = urls
      ? pickLinks(
          conversationId,
          urls,
          shownById.get(conversationId) ?? new Set(),
        )
      : [];
    if (picked.length > 0) links.set(conversationId, picked);
  }
  return { links, media };
}
