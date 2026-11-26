import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { rootVisibleToViewer } from "@/api/conversations/membership";
import { getDb } from "@/chat/db";
import { juniorConversations, juniorTodos } from "@/db/schema";
import { todoFuzzyTitle, todoSearchDocument } from "@/db/schema/todos";
import { rankSearchMatches, scoredSearchMatches } from "@/search/match-ranking";
import {
  fuzzyMatch,
  fuzzyRank,
  prefixMatch,
  prefixRank,
  SEARCH_RANK_WINDOW,
} from "@/search/text-match";
import type { TypedQuery } from "@/search/typed-query";
import { isOpenTodoStatus, type TodoStatus } from "./types";

/** A To-do that matches a search. */
export interface TodoSearchMatch {
  conversationId: string;
  id: number;
  status: TodoStatus;
  title: string;
}

/**
 * Find the To-dos whose Conversation shows its private content to the
 * viewer: its root is public, or the viewer is a Participant of the root,
 * as `conversationAccessFromRows` decides. Other viewers see only redacted
 * To-dos, so a title match must not show that the To-do exists. A word of
 * the title starts with each word of the query, or the title is close to
 * the query despite a typo. Open To-dos come first, each group best match
 * first. Reads the GIN indexes `junior_todos_search_idx` and
 * `junior_todos_title_trgm_idx`.
 */
export async function searchTodosForViewer(
  viewer: User,
  query: TypedQuery,
  limit: number,
): Promise<TodoSearchMatch[]> {
  const db = getDb();
  const todos = juniorTodos;
  const conversation = alias(juniorConversations, "todo_conversation");
  // `rootVisibleToViewer` reads the root as `juniorConversations`. The joins
  // keep only a valid tree:
  // the root is its own root, and the Conversation is the root or a child.
  const candidates = db
    .select({ conversationId: todos.conversationId, id: todos.id })
    .from(todos)
    .innerJoin(
      conversation,
      eq(conversation.conversationId, todos.conversationId),
    )
    .innerJoin(
      juniorConversations,
      and(
        eq(
          juniorConversations.conversationId,
          conversation.topLevelConversationId,
        ),
        eq(
          juniorConversations.topLevelConversationId,
          juniorConversations.conversationId,
        ),
      ),
    )
    .where(
      and(
        or(
          prefixMatch(todoSearchDocument(todos), query),
          fuzzyMatch(todoFuzzyTitle(todos), query),
        ),
        or(
          isNotNull(conversation.parentConversationId),
          eq(conversation.topLevelConversationId, conversation.conversationId),
        ),
        rootVisibleToViewer(viewer.id),
      ),
    )
    .orderBy(desc(todos.updatedAt), desc(todos.conversationId), desc(todos.id))
    .limit(SEARCH_RANK_WINDOW)
    .as("todo_candidates");
  const todo = alias(juniorTodos, "todo");
  const document = todoSearchDocument(todo);
  const title = todoFuzzyTitle(todo);
  const rows = await db
    .select({
      conversationId: todo.conversationId,
      fuzzy: fuzzyRank(title, query),
      fuzzyMatched: fuzzyMatch(title, query),
      id: todo.id,
      lexical: prefixRank(document, query),
      lexicalMatched: prefixMatch(document, query),
      status: todo.status,
      title: todo.title,
      updatedAt: todo.updatedAt,
    })
    .from(candidates)
    .innerJoin(
      todo,
      and(
        eq(todo.conversationId, candidates.conversationId),
        eq(todo.id, candidates.id),
      ),
    );
  const ranked = rankSearchMatches(
    scoredSearchMatches(rows, {
      fuzzy: (row) => (row.fuzzyMatched ? Number(row.fuzzy) : undefined),
      lexical: (row) => (row.lexicalMatched ? Number(row.lexical) : undefined),
    }),
    {
      key: (row) => `${row.conversationId}:${row.id}`,
      tiebreak: (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() ||
        right.conversationId.localeCompare(left.conversationId) ||
        right.id - left.id,
    },
  );
  return [
    ...ranked.filter((row) => isOpenTodoStatus(row.status)),
    ...ranked.filter((row) => !isOpenTodoStatus(row.status)),
  ]
    .slice(0, limit)
    .map(({ conversationId, id, status, title }) => ({
      conversationId,
      id,
      status,
      title,
    }));
}
