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

// Omit each variant on its own, so the `run` or `to` pair survives.
type UnscoredItem<T> = T extends unknown ? Omit<T, "matches" | "score"> : never;

/**
 * Score a row against the typed text: a label match first, then a plain
 * match in `text`, such as an email. Returns undefined when nothing
 * matches. With no typed text, every row stays.
 */
export function matchedItem(
  item: UnscoredItem<PaletteItem>,
  query: string | undefined,
  text: readonly (string | null | undefined)[] = [],
): PaletteItem | undefined {
  if (!query) return { ...item, score: 0 };
  const match = quickOpenMatch(item.label, query);
  if (match) return { ...item, matches: match.indices, score: match.score };
  const needle = query.toLowerCase();
  return text.some((value) => value?.toLowerCase().includes(needle))
    ? { ...item, score: TEXT_MATCH_SCORE }
    : undefined;
}
