import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, union } from "drizzle-orm/pg-core";
import { codeChangeUrl, linkedCodeProviders } from "@/chat/code/links";
import { getDb } from "@/chat/db";
import { listedConversation } from "@/chat/conversations/sql/listed";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorConversations,
} from "@/db/schema";
import {
  codeChangeSearchDocument,
  codeRepositorySearchDocument,
} from "@/db/schema/code";
import { rootVisibleToViewer } from "../conversations/membership";
import type { MentionableCodeChange } from "../schema/code";

// One menu of changes. More rows do not help a person who is still typing.
const CODE_CHANGE_SEARCH_LIMIT = 8;
// More words only narrow the match further.
const CODE_CHANGE_SEARCH_TERMS = 4;
// The search takes milliseconds. A typeahead result after seconds is stale.
const CODE_CHANGE_SEARCH_TIMEOUT_MS = 3_000;

const matched = alias(juniorCodeChanges, "matched");
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
  // A menu entry links to the change, so skip providers with no links.
  const providers = linkedCodeProviders();
  if (terms.length === 0 || providers.length === 0) return [];
  // The terms hold only letters and digits, so they cannot add tsquery
  // syntax.
  const everyTerm = terms.map((term) => `${term}:*`).join(" & ");
  const anyTerm = terms.map((term) => `${term}:*`).join(" | ");
  const db = getDb();
  const changeDocument = codeChangeSearchDocument(juniorCodeChanges);
  const repositoryDocument = codeRepositorySearchDocument(
    juniorCodeRepositories,
  );
  // Each branch reads one index, and checks every word only on the changes
  // that the index found. One word needs no second check.
  const textMatch = (condition: SQL) =>
    db
      .select({ id: matched.id })
      .from(matched)
      .innerJoin(
        juniorCodeRepositories,
        eq(juniorCodeRepositories.id, matched.repositoryId),
      )
      .where(
        and(
          condition,
          terms.length > 1
            ? sql`(${codeChangeSearchDocument(matched)} || ${repositoryDocument}) @@ to_tsquery('simple', ${everyTerm})`
            : undefined,
        ),
      );
  const matches = number
    ? and(
        sql`${changeDocument} @@ to_tsquery('simple', ${everyTerm})`,
        // The index finds every word that starts with the digits. Keep the
        // changes whose number starts with them.
        sql`${juniorCodeChanges.number}::text like ${`${number}%`}`,
      )
    : // A word can match the title or the repository name, and every word
      // must match one of them.
      inArray(
        juniorCodeChanges.id,
        union(
          textMatch(
            sql`${codeChangeSearchDocument(matched)} @@ to_tsquery('simple', ${anyTerm})`,
          ),
          textMatch(
            sql`${repositoryDocument} @@ to_tsquery('simple', ${anyTerm})`,
          ),
        ),
      );
  // The same rule as the feed of one repository: a root Conversation linked
  // to the change that is public or that the viewer takes part in. It starts
  // from the IDs on the change and reads each root by primary key, so its
  // cost does not grow with the number of Conversations.
  const visible = exists(
    db
      .select({ conversationId: juniorConversations.conversationId })
      .from(linked)
      .innerJoin(
        juniorConversations,
        eq(
          juniorConversations.conversationId,
          sql`coalesce(${linked.topLevelConversationId}, ${linked.conversationId})`,
        ),
      )
      .where(
        and(
          sql`${linked.conversationId} = any(${juniorCodeChanges.conversationIds})`,
          listedConversation(),
          rootVisibleToViewer(viewerUserId),
        ),
      ),
  );
  // A bad plan fails fast instead of holding a connection while the person
  // types on. Only a session's statement_timeout cancels the query in
  // Postgres, so the read runs in a transaction.
  const rows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${String(CODE_CHANGE_SEARCH_TIMEOUT_MS)}, true)`,
    );
    return await tx
      .select({
        number: juniorCodeChanges.number,
        provider: juniorCodeChanges.provider,
        repository: juniorCodeRepositories.name,
        state: juniorCodeChanges.state,
        title: juniorCodeChanges.title,
      })
      .from(juniorCodeChanges)
      .innerJoin(
        juniorCodeRepositories,
        eq(juniorCodeRepositories.id, juniorCodeChanges.repositoryId),
      )
      .where(
        and(matches, inArray(juniorCodeChanges.provider, providers), visible),
      )
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
  });
  return rows.flatMap(({ provider, ...row }) => {
    const url = codeChangeUrl({ ...row, provider });
    return url ? [{ ...row, url }] : [];
  });
}
