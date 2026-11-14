import type { LucideIcon } from "lucide-react";

import type { FOCUS_REPLY_STATE } from "../conversations/conversationRoutes";
import { quickOpenMatch } from "./quickOpenMatch";

/** One command palette row: a place to go, or an action to run. */
export type PaletteItem = {
  group: string;
  icon: LucideIcon;
  id: string;
  label: string;
  /** Label indices that the typed text matched. */
  matches?: number[];
  meta?: string;
  score: number;
  /** Navigation state for the destination page. */
  state?: typeof FOCUS_REPLY_STATE;
} & ({ run(): void; to?: undefined } | { run?: undefined; to: string });

// Below any label match, so rows that match only other text rank last.
const TEXT_MATCH_SCORE = 1;

/**
 * Score a row against the typed text: a label match first, then a plain
 * match in `text`, such as an email. Returns undefined when nothing
 * matches. With no typed text, every row stays.
 */
export function matchedItem(
  item: Omit<PaletteItem, "matches" | "score">,
  query: string | undefined,
  text: readonly (string | null | undefined)[] = [],
): PaletteItem | undefined {
  const row = item as PaletteItem;
  if (!query) return { ...row, score: 0 };
  const match = quickOpenMatch(item.label, query);
  if (match) return { ...row, matches: match.indices, score: match.score };
  const needle = query.toLowerCase();
  return text.some((value) => value?.toLowerCase().includes(needle))
    ? { ...row, score: TEXT_MATCH_SCORE }
    : undefined;
}
