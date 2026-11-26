/**
 * The searchable text of one Conversation event: the words that a person or
 * the agent wrote, and the tool calls and results. Runtime context parts,
 * model reasoning, images, usage, and ids are not searchable text.
 *
 * One SQL expression reads the text for keyword search, embeddings, and
 * excerpts, so the three always see the same words.
 */
import { sql, type SQL } from "drizzle-orm";
import { juniorConversationEvents } from "@/db/schema";
import { RUNTIME_CONTEXT_TEXT_STARTS } from "@/chat/pi/transcript";
import type { KnownConversationEventType } from "./history";
import { storedMessageJson } from "./sql/message-json";

/** Event types that have searchable text. Other events never match a query. */
export const SEARCHABLE_EVENT_TYPES = [
  "message",
  "message_updated",
  "user_message",
  "assistant_message",
  "tool_result",
] as const satisfies readonly KnownConversationEventType[];

const EXCERPT_CHARS = 400;
const EXCERPT_LEAD_CHARS = 120;
const MAX_EXCERPT_TERMS = 16;

// Agent history stores the Pi message as a JSON string. Schema version 1 rows
// store its fields in the payload. Each path selects one kind of part.
const runtimeContextFilter = RUNTIME_CONTEXT_TEXT_STARTS.map(
  (start) => `!(@.text starts with ${JSON.stringify(start)})`,
).join(" && ");
const AGENT_HISTORY_TEXT_PATHS = [
  'lax $.content ? (@.type() == "string")',
  'lax $.toolName ? (@.type() == "string")',
  `lax $.content[*] ? (@.type == "text" && ${runtimeContextFilter}).text`,
  'lax $.content[*] ? (@.type == "toolCall").name',
  'lax $.content[*] ? (@.type == "toolCall").arguments.** ? (@.type() == "string" || @.type() == "number")',
];

/** SQL condition: the row is an agent message that calls a tool. */
export function callsToolSql(): SQL<boolean> {
  const { payload, type } = juniorConversationEvents;
  return sql<boolean>`(${type} = 'assistant_message' AND jsonb_path_exists(
    coalesce(${storedMessageJson(sql`${payload}->>'message'`)}, ${payload}),
    'lax $.content[*] ? (@.type == "toolCall")'
  ))`;
}

/**
 * SQL expression for the searchable text of a `junior_conversation_events`
 * row. Null for an event without searchable text.
 */
export function eventSearchTextSql(): SQL<string | null> {
  const { payload, type } = juniorConversationEvents;
  const message = sql.raw("searchable_message.value");
  const parts = sql.join(
    AGENT_HISTORY_TEXT_PATHS.map(
      (path) => sql`select jsonb_path_query(${message}, ${path}::jsonpath)`,
    ),
    sql` union all `,
  );
  return sql<string | null>`CASE
    WHEN ${type} IN ('message', 'message_updated') THEN ${payload}->>'text'
    WHEN ${type} IN ('user_message', 'assistant_message', 'tool_result') THEN (
      SELECT string_agg(part #>> '{}', E'\\n')
      FROM (SELECT coalesce(${storedMessageJson(sql`${payload}->>'message'`)}, ${payload}) AS value) searchable_message
      CROSS JOIN LATERAL (${parts}) searchable_parts(part)
    )
  END`;
}

/** Split a query into lowercase words for excerpts, with path parts too. */
export function excerptTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
  const parts = words.flatMap((word) => word.split(/[/#\\:@?&=]+/));
  return [...new Set([...words, ...parts])]
    .filter((term) => term.length >= 2)
    .slice(0, MAX_EXCERPT_TERMS);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + needle.length)
  ) {
    count += 1;
  }
  return count;
}

/**
 * Return a short window of the text around the most specific query word:
 * the word that occurs least often, and the longest on a tie. Text without a
 * query word, such as a match by meaning, gives its start.
 */
export function eventExcerpt(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase();
  const best = terms
    .map((term) => ({ term, count: countOccurrences(lower, term) }))
    .filter(({ count }) => count > 0)
    .sort(
      (left, right) =>
        left.count - right.count || right.term.length - left.term.length,
    )[0];
  const position = best ? lower.indexOf(best.term) : 0;
  const start = Math.max(0, position - EXCERPT_LEAD_CHARS);
  const end = Math.min(text.length, start + EXCERPT_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
