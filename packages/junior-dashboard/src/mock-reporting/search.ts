import {
  searchQuerySchema,
  type AutomationListItem,
  type SearchInboxItem,
  type SearchMemory,
  type SearchReport,
} from "@sentry/junior/api/schema";

// The API returns at most this many rows per group.
const MOCK_SEARCH_LIMIT = 8;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether each word of the query starts a word of the text. */
function prefixMatch(text: string, query: string): boolean {
  const textWords = words(text);
  const queryWords = words(query);
  return (
    queryWords.length > 0 &&
    queryWords.every((term) => textWords.some((word) => word.startsWith(term)))
  );
}

/**
 * The rows that the API would find, in a close order: the `lead` rows
 * first, then title matches, then matches in the rest of the text. The mock
 * leaves out typo matches.
 */
function matches<T extends { title: string }>(
  rows: readonly T[],
  query: string,
  text: (row: T) => string,
  lead: (row: T) => boolean = () => false,
): T[] {
  const rank = (row: T) =>
    Number(lead(row)) * 2 + Number(prefixMatch(row.title, query));
  return rows
    .filter(
      (row) => prefixMatch(row.title, query) || prefixMatch(text(row), query),
    )
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, MOCK_SEARCH_LIMIT);
}

// The task and event trigger words that the API matches besides the title.
function automationText(automation: AutomationListItem): string {
  const task =
    automation.task.kind === "instruction"
      ? automation.task.instruction
      : automation.task.skill;
  return automation.kind === "event"
    ? `${task} ${automation.resource} ${automation.source}`
    : task;
}

/**
 * Answer `/api/search` from mock rows for the sources that the request
 * names, or undefined for an invalid query.
 */
export function mockSearchReport(
  rows: {
    automations: readonly AutomationListItem[];
    inboxItems: readonly (SearchInboxItem & { body: string })[];
    memories: readonly SearchMemory[];
  },
  params: URLSearchParams,
): SearchReport | undefined {
  const query = searchQuerySchema.safeParse(Object.fromEntries(params));
  if (!query.success) return undefined;
  const { q, sources } = query.data;
  return {
    ...(sources.includes("automations")
      ? {
          automations: matches(rows.automations, q, automationText).map(
            ({ id, kind, status, title }) => ({ id, kind, status, title }),
          ),
        }
      : undefined),
    ...(sources.includes("inboxItems")
      ? {
          inboxItems: matches(
            rows.inboxItems,
            q,
            (item) => item.body,
            (item) => item.status === "open",
          ).map(({ id, status, title }) => ({ id, status, title })),
        }
      : undefined),
    ...(sources.includes("memories")
      ? { memories: matches(rows.memories, q, (memory) => memory.title) }
      : undefined),
  };
}
