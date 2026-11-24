import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import type { JuniorDatabase } from "@/db/db";
import { codeChangeUrl, parseCodeChangeUrl } from "@/chat/code/links";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorInboxItemConversations,
  juniorInboxItems,
} from "@/db/schema";
import { inboxItemVisibleTo, type InboxItemReader } from "./access";
import { ownerConversationId, type InboxItem } from "./store";
import { codeChangeSubjectProvider } from "./subject-links";
import {
  INBOX_SUBJECT_KINDS,
  questionLinks,
  subjectKindPlugin,
} from "./subjects";

// Each item keeps at most this many related items, newest first.
const RELATED_ITEM_LIMIT = 10;
// The reads keep this many of the newest candidates for each object and
// linked Conversation, so a busy object cannot crowd out
// the other items on the page. One more than the item limit, because an
// item can be a candidate for its own object.
const RELATED_CANDIDATE_LIMIT = RELATED_ITEM_LIMIT + 1;

/** Other open work on the same object or linked work as one item. */
export interface RelatedReviewWork {
  /**
   * The item's linked Conversations other than the one that added it, that
   * the viewer can see.
   */
  conversationIds: string[];
  /** Other open items that the reader can see, newest first. */
  items: Array<{ id: string; title: string }>;
}

type Candidate = {
  createdAt: Date;
  id: string;
  title: string;
};

/** The linked Conversations of an item that point to other work. */
function linkedWork(item: InboxItem): string[] {
  return item.conversationIds.filter((id) => id !== ownerConversationId(item));
}

/**
 * The Conversations where an item's related work can be: its linked work,
 * and the Conversations that a question cites as evidence.
 */
function workConversations(item: InboxItem): string[] {
  const cited = (item.request?.evidence ?? []).flatMap((entry) =>
    entry.conversationId ? [entry.conversationId] : [],
  );
  return [...new Set([...linkedWork(item), ...cited])].filter(
    (id) => id !== ownerConversationId(item),
  );
}

function openVisible(reader: InboxItemReader): SQL {
  return and(eq(juniorInboxItems.status, "open"), inboxItemVisibleTo(reader))!;
}

/** Rank the candidates in each group, newest first. */
function newestInGroup(group: AnyPgColumn) {
  return sql<number>`row_number() over (partition by ${group} order by ${juniorInboxItems.createdAt} desc, ${juniorInboxItems.id} desc)`;
}

const candidateColumns = {
  createdAt: juniorInboxItems.createdAt,
  id: juniorInboxItems.id,
  title: juniorInboxItems.title,
};

/**
 * The code change records that join the two names of one code change: the
 * provider id that a plugin item has, and the web page that a question
 * cites.
 */
interface CodeChangeLinks {
  /** The provider ids of the code change at each cited web page. */
  ids: Map<string, string[]>;
  /** The web page of each code change, by provider and provider id. */
  urls: Map<string, string>;
}

function codeChangeKey(provider: string, providerId: string): string {
  return `${provider}\n${providerId}`;
}

/**
 * Read in one query the web pages of the page's code change items and the
 * code changes at the pages that its questions cite.
 */
async function readCodeChangeLinks(
  db: JuniorDatabase,
  items: readonly InboxItem[],
): Promise<CodeChangeLinks> {
  const links: CodeChangeLinks = { ids: new Map(), urls: new Map() };
  const owned = new Map<string, Set<string>>();
  for (const item of items) {
    const provider = codeChangeSubjectProvider(item.subject.kind);
    if (!provider) continue;
    owned.set(
      provider,
      (owned.get(provider) ?? new Set()).add(item.subject.id),
    );
  }
  const cited = [
    ...new Set(
      items.flatMap((item) =>
        item.subject.kind === INBOX_SUBJECT_KINDS.question
          ? questionLinks(item)
          : [],
      ),
    ),
  ].flatMap((url) =>
    parseCodeChangeUrl(url).map((change) => ({ ...change, url })),
  );
  if (owned.size === 0 && cited.length === 0) return links;
  const rows = await db
    .select({
      number: juniorCodeChanges.number,
      provider: juniorCodeChanges.provider,
      providerId: juniorCodeChanges.providerId,
      repository: juniorCodeRepositories.name,
    })
    .from(juniorCodeChanges)
    .innerJoin(
      juniorCodeRepositories,
      eq(juniorCodeRepositories.id, juniorCodeChanges.repositoryId),
    )
    .where(
      or(
        ...[...owned].map(([provider, ids]) =>
          and(
            eq(juniorCodeChanges.provider, provider),
            inArray(juniorCodeChanges.providerId, [...ids]),
          ),
        ),
        ...cited.map((change) =>
          and(
            eq(juniorCodeChanges.provider, change.provider),
            eq(juniorCodeChanges.number, change.number),
            sql`lower(${juniorCodeRepositories.name}) = ${change.repository.toLowerCase()}`,
          ),
        ),
      ),
    );
  for (const row of rows) {
    const url = codeChangeUrl(row);
    if (url) links.urls.set(codeChangeKey(row.provider, row.providerId), url);
    for (const change of cited) {
      if (
        change.provider === row.provider &&
        change.number === row.number &&
        change.repository.toLowerCase() === row.repository.toLowerCase()
      ) {
        links.ids.set(change.url, [
          ...(links.ids.get(change.url) ?? []),
          row.providerId,
        ]);
      }
    }
  }
  return links;
}

/**
 * The outside objects that an item is about, which related work matches: a
 * plugin item's subject id, such as a pull request, or the links of a
 * question's evidence. A code change has two names, its provider id and its
 * web page, so an item about one also matches the other. Other core kinds
 * relate to nothing by object.
 */
function relatedObjects(item: InboxItem, links: CodeChangeLinks): string[] {
  const { id, kind } = item.subject;
  if (kind === INBOX_SUBJECT_KINDS.question) {
    const urls = questionLinks(item);
    return [...urls, ...urls.flatMap((url) => links.ids.get(url) ?? [])];
  }
  if (!subjectKindPlugin(kind)) return [];
  const provider = codeChangeSubjectProvider(kind);
  const url = provider && links.urls.get(codeChangeKey(provider, id));
  return url ? [id, url] : [id];
}

/** The evidence links of a question row that are among `objects`. */
function citedObjects(objects: readonly string[]) {
  const vars = sql`${JSON.stringify({ objects })}::jsonb`;
  return {
    // A question that cites none of the objects is no candidate for them.
    cites: and(
      eq(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.question),
      sql`jsonb_path_exists(${juniorInboxItems.request}, '$.evidence[*].url ? (@ == $objects[*])', ${vars})`,
    )!,
    first: sql`jsonb_path_query_first(${juniorInboxItems.request}, '$.evidence[*].url ? (@ == $objects[*])', ${vars}) #>> '{}'`,
  };
}

/**
 * Read the related work of each open item in a page: the other open items
 * that the reader can see about the same object (`relatedObjects`), or in
 * one of the Conversations that the item links or cites, and the linked
 * Conversations when the viewer can see them. The reads cover the whole
 * page at once, so the query count does not grow with the page.
 */
export async function readRelatedReviewWork(
  db: JuniorDatabase,
  reader: InboxItemReader,
  viewer: User,
  items: readonly InboxItem[],
): Promise<Map<string, RelatedReviewWork>> {
  const open = items.filter((item) => item.status === "open");
  const links = await readCodeChangeLinks(db, open);
  const objects = [
    ...new Set(open.flatMap((item) => relatedObjects(item, links))),
  ];
  const linkIds = [...new Set(open.flatMap(workConversations))];
  const viewIds = [...new Set(open.flatMap(linkedWork))];
  const cited = citedObjects(objects);
  // A question's key is no object: only its evidence says what it is about.
  const named = and(
    ne(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.question),
    inArray(juniorInboxItems.subjectId, objects),
  )!;
  // A row's object: its subject id when that names one of the objects, else
  // the first of them that it cites.
  const object = sql<string>`case when ${named} then ${juniorInboxItems.subjectId} else ${cited.first} end`;
  const objectRanks = db
    .select({
      ...candidateColumns,
      objects: sql<
        string[]
      >`jsonb_path_query_array(${juniorInboxItems.request}, '$.evidence[*].url')`.as(
        "objects",
      ),
      subjectId: juniorInboxItems.subjectId,
      subjectKind: juniorInboxItems.subjectKind,
      rank: sql<number>`row_number() over (partition by ${object} order by ${juniorInboxItems.createdAt} desc, ${juniorInboxItems.id} desc)`.as(
        "object_rank",
      ),
    })
    .from(juniorInboxItems)
    .where(and(openVisible(reader), or(named, cited.cites)))
    .as("object_ranks");
  const linkRanks = db
    .select({
      ...candidateColumns,
      conversationId: juniorInboxItemConversations.conversationId,
      rank: newestInGroup(juniorInboxItemConversations.conversationId).as(
        "link_rank",
      ),
    })
    .from(juniorInboxItemConversations)
    .innerJoin(
      juniorInboxItems,
      eq(juniorInboxItems.id, juniorInboxItemConversations.itemId),
    )
    .where(
      and(
        inArray(juniorInboxItemConversations.conversationId, linkIds),
        openVisible(reader),
      ),
    )
    .as("link_ranks");
  const [byObject, byLink, access] = await Promise.all([
    objects.length > 0
      ? db
          .select({
            createdAt: objectRanks.createdAt,
            id: objectRanks.id,
            objects: objectRanks.objects,
            subjectId: objectRanks.subjectId,
            subjectKind: objectRanks.subjectKind,
            title: objectRanks.title,
          })
          .from(objectRanks)
          .where(lte(objectRanks.rank, RELATED_CANDIDATE_LIMIT))
      : [],
    linkIds.length > 0
      ? db
          .select({
            conversationId: linkRanks.conversationId,
            createdAt: linkRanks.createdAt,
            id: linkRanks.id,
            title: linkRanks.title,
          })
          .from(linkRanks)
          .where(lte(linkRanks.rank, RELATED_CANDIDATE_LIMIT))
      : [],
    readConversationAccessFromSql(db, viewIds, viewer),
  ]);
  const related = new Map<string, RelatedReviewWork>();
  for (const item of open) {
    const about = new Set(relatedObjects(item, links));
    const work = new Set(workConversations(item));
    const matches = new Map<string, Candidate>();
    for (const candidate of byObject) {
      const candidateObjects =
        candidate.subjectKind === INBOX_SUBJECT_KINDS.question
          ? (candidate.objects ?? [])
          : [candidate.subjectId];
      if (candidateObjects.some((object) => about.has(object))) {
        matches.set(candidate.id, candidate);
      }
    }
    for (const candidate of byLink) {
      if (work.has(candidate.conversationId)) {
        matches.set(candidate.id, candidate);
      }
    }
    matches.delete(item.id);
    related.set(item.id, {
      conversationIds: linkedWork(item).filter(
        (id) => access.get(id)?.canViewPrivateContent === true,
      ),
      items: [...matches.values()]
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id),
        )
        .slice(0, RELATED_ITEM_LIMIT)
        .map(({ id, title }) => ({ id, title })),
    });
  }
  return related;
}
