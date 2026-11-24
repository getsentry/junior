import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import { juniorAutomations } from "@/db/schema";
import {
  automationFuzzyTitle,
  automationSearchDocument,
} from "@/db/schema/automations";
import { rankSearchMatches, scoredSearchMatches } from "@/search/match-ranking";
import {
  fuzzyMatch,
  fuzzyRank,
  prefixMatch,
  prefixRank,
  SEARCH_RANK_WINDOW,
} from "@/search/text-match";
import type { TypedQuery } from "@/search/typed-query";
import { viewerAutomationCollection } from "./collection";
import { collectionRowTitle } from "./read";
import type { AutomationViewer } from "./creator";

// A pasted id names one Automation, so it outranks every word match.
const EXACT_ID_WEIGHT = 4;

/** An Automation that matches a search. */
export type AutomationSearchMatch = {
  id: string;
  kind: "event" | "scheduled";
  status: "active" | "blocked" | "paused" | "completed";
  title: string;
};

/**
 * Find the Automations that the viewer owns or that are shared to them, as
 * the Automations list shows them and with its titles. A word of the title, task, or event
 * trigger starts with each word of the query, the title is close to the
 * query despite a typo, or the query holds the Automation's id. Best match
 * first. Reads the GIN indexes `junior_automations_search_idx` and
 * `junior_automations_title_trgm_idx`.
 */
export async function searchAutomationsForViewer(
  viewer: AutomationViewer,
  query: TypedQuery,
  limit: number,
): Promise<AutomationSearchMatch[]> {
  const db = getDb();
  const collection = viewerAutomationCollection(viewer);
  // The search columns are not in the collection, so match on the row.
  const automation = alias(juniorAutomations, "search_automation");
  // The newest matches, before any is ranked.
  const candidates = db
    .select({
      activityAtMs: collection.activityAtMs,
      id: collection.id,
      kind: collection.kind,
      state: collection.state,
      task: collection.task,
      title: collection.title,
    })
    .from(collection)
    .innerJoin(automation, eq(automation.id, collection.id))
    .where(
      and(
        ne(automation.status, "deleted"),
        or(
          prefixMatch(automationSearchDocument(automation), query),
          fuzzyMatch(automationFuzzyTitle(automation), query),
          query.tokens.length > 0
            ? inArray(automation.id, query.tokens)
            : undefined,
        ),
      ),
    )
    .orderBy(desc(collection.activityAtMs), asc(collection.id))
    .limit(SEARCH_RANK_WINDOW)
    .as("automation_candidates");
  const ranked = alias(juniorAutomations, "ranked_automation");
  const document = automationSearchDocument(ranked);
  const title = automationFuzzyTitle(ranked);
  const rows = await db
    .select({
      activityAtMs: candidates.activityAtMs,
      fuzzy: fuzzyRank(title, query),
      fuzzyMatched: fuzzyMatch(title, query),
      id: candidates.id,
      kind: candidates.kind,
      lexical: prefixRank(document, query),
      lexicalMatched: prefixMatch(document, query),
      state: candidates.state,
      task: candidates.task,
      title: candidates.title,
    })
    .from(candidates)
    .innerJoin(ranked, eq(ranked.id, candidates.id));
  return rankSearchMatches(
    scoredSearchMatches(rows, {
      exact: (row) => (query.tokens.includes(row.id) ? 1 : undefined),
      fuzzy: (row) => (row.fuzzyMatched ? Number(row.fuzzy) : undefined),
      lexical: (row) => (row.lexicalMatched ? Number(row.lexical) : undefined),
    }),
    {
      key: (row) => row.id,
      tiebreak: (left, right) =>
        right.activityAtMs - left.activityAtMs ||
        left.id.localeCompare(right.id),
      weights: { exact: EXACT_ID_WEIGHT },
    },
  )
    .slice(0, limit)
    .flatMap((row) =>
      // The collection leaves out deleted Automations.
      row.state === "deleted"
        ? []
        : [
            {
              id: row.id,
              kind: row.kind,
              status: row.state,
              title: collectionRowTitle(row),
            },
          ],
    );
}
