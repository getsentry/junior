import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import { alias, union } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import { listedConversation } from "@/chat/conversations/sql/listed";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import {
  codeChangeSearchDocument,
  codeRepositorySearchDocument,
} from "@/db/schema/code";
import { rootVisibleToViewer } from "../conversations/membership";
import { conversationRecordJoins } from "../conversations/record";
import type { MentionableCodeChange } from "../schema/code";

// One menu of changes. More rows do not help a person who is still typing.
const CODE_CHANGE_SEARCH_LIMIT = 8;
// More words only narrow the match further.
const CODE_CHANGE_SEARCH_TERMS = 4;

const titleMatch = alias(juniorCodeChanges, "title_match");
const repositoryMatch = alias(juniorCodeChanges, "repository_match");
const linked = alias(juniorConversations, "linked_conversation");

/**
 * Find code changes for the composer `#` menu, newest activity first. A
 * query of digits, with an optional leading `#`, matches the start of the
 * number. Other text matches word prefixes of the title and the repository
 * name. The viewer finds only changes linked to a Conversation that they can
 * find in the feed. It reads the indexes `junior_code_changes_search_idx` and
 * `junior_code_repositories_search_idx` in one statement.
 */
export async function readCodeChangeSearchFromSql(
  query: string,
  viewerUserId: string,
): Promise<MentionableCodeChange[]> {
  const number = /^#?(\d+)$/.exec(query.trim())?.[1];
  const terms = number
    ? [number]
    : (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(
        0,
        CODE_CHANGE_SEARCH_TERMS,
      );
  if (terms.length === 0) return [];
  // The terms hold only letters and digits, so they cannot add tsquery
  // syntax.
  const everyTerm = terms.map((term) => `${term}:*`).join(" & ");
  const anyTerm = terms.map((term) => `${term}:*`).join(" | ");
  const db = getDb();
  const changeDocument = codeChangeSearchDocument(juniorCodeChanges);
  const matches = number
    ? and(
        sql`${changeDocument} @@ to_tsquery('simple', ${everyTerm})`,
        // The index finds every word that starts with the digits. Keep the
        // changes whose number starts with them.
        sql`${juniorCodeChanges.number}::text like ${`${number}%`}`,
      )
    : and(
        // A word can match the title or the repository name. Each index
        // finds the changes that match one of the words.
        inArray(
          juniorCodeChanges.id,
          union(
            db
              .select({ id: titleMatch.id })
              .from(titleMatch)
              .where(
                sql`${codeChangeSearchDocument(titleMatch)} @@ to_tsquery('simple', ${anyTerm})`,
              ),
            db
              .select({ id: repositoryMatch.id })
              .from(repositoryMatch)
              .innerJoin(
                juniorCodeRepositories,
                eq(juniorCodeRepositories.id, repositoryMatch.repositoryId),
              )
              .where(
                sql`${codeRepositorySearchDocument(juniorCodeRepositories)} @@ to_tsquery('simple', ${anyTerm})`,
              ),
          ),
        ),
        sql`(${changeDocument} || ${codeRepositorySearchDocument(juniorCodeRepositories)}) @@ to_tsquery('simple', ${everyTerm})`,
      );
  // The same rule as the feed of one repository: a root Conversation linked
  // to the change that is public or that the viewer takes part in.
  const visible = exists(
    db
      .select({ conversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .leftJoin(juniorDestinations, conversationRecordJoins.location)
      .where(
        and(
          listedConversation(),
          rootVisibleToViewer(viewerUserId),
          inArray(
            juniorConversations.conversationId,
            db
              .select({
                rootConversationId: sql`coalesce(${linked.rootConversationId}, ${linked.conversationId})`,
              })
              .from(linked)
              .where(
                sql`${linked.conversationId} = any(${juniorCodeChanges.conversationIds})`,
              ),
          ),
        ),
      ),
  );
  const rows = await db
    .select({
      draft: juniorCodeChanges.draft,
      number: juniorCodeChanges.number,
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
    .where(and(matches, isNotNull(juniorCodeChanges.url), visible))
    .orderBy(
      ...(number
        ? [desc(sql`${juniorCodeChanges.number}::text = ${number}`)]
        : []),
      desc(
        sql`coalesce(${juniorCodeChanges.lastActivityAt}, ${juniorCodeChanges.openedAt})`,
      ),
      asc(juniorCodeChanges.id),
    )
    .limit(CODE_CHANGE_SEARCH_LIMIT);
  return rows.flatMap((row) => (row.url ? [{ ...row, url: row.url }] : []));
}
