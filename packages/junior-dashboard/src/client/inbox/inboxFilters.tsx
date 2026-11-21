import type { InboxItemPayload } from "@sentry/junior/api/schema";
import { Pin } from "lucide-react";

import { ScopeTabs } from "../components/filters/ScopeTabs";
import { isCodeChangeItem, isDecisionItem } from "./inboxModel";

/**
 * The type of an ask, as the Inbox filters split them. A pull request ask
 * is a Pull request even when it asks a question. Other holds the rest,
 * such as To-dos, text questions, and Resume.
 */
export type AskType = "decisions" | "other" | "prs";

/** The Inbox filter: every ask, or the asks of one type. */
export type InboxTypeFilter = AskType | "all";

const TYPE_PARAM = "type";
const PINNED_PARAM = "pinned";

const TYPE_FILTERS: readonly { key: InboxTypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "prs", label: "Pull requests" },
  { key: "decisions", label: "Decisions" },
  { key: "other", label: "Other" },
];

/** Say which type an ask is. */
export function askTypeOf(item: InboxItemPayload): AskType {
  if (isCodeChangeItem(item)) return "prs";
  if (isDecisionItem(item)) return "decisions";
  return "other";
}

/** Read the type filter from `?type=`. Other values show All. */
export function inboxTypeOf(search: URLSearchParams): InboxTypeFilter {
  const value = search.get(TYPE_PARAM);
  return TYPE_FILTERS.find((filter) => filter.key === value)?.key ?? "all";
}

/** Read from `?pinned=1` whether a list shows only the viewer's pins. */
export function pinnedOnlyOf(search: URLSearchParams): boolean {
  return search.get(PINNED_PARAM) === "1";
}

/**
 * Pick the type of ask that the Inbox shows, with each type's count of the
 * asks that wait on the viewer. A type with nothing waiting hides, unless
 * it is on; All always shows.
 */
export function InboxTypeFilters(props: {
  counts: Partial<Record<InboxTypeFilter, number>>;
  search: string;
  type: InboxTypeFilter;
}) {
  const tabs = TYPE_FILTERS.filter(
    (filter) =>
      filter.key === "all" ||
      filter.key === props.type ||
      (props.counts[filter.key] ?? 0) > 0,
  ).map((filter) => {
    const params = new URLSearchParams(props.search);
    if (filter.key === "all") params.delete(TYPE_PARAM);
    else params.set(TYPE_PARAM, filter.key);
    return {
      count: props.counts[filter.key],
      label: filter.label,
      on: filter.key === props.type,
      search: params.toString(),
    };
  });
  return <ScopeTabs label="Asks to show" tabs={tabs} />;
}

/** Toggle between every row and only the viewer's pinned Conversations. */
export function PinnedFilter(props: { on: boolean; search: string }) {
  const params = new URLSearchParams(props.search);
  if (props.on) params.delete(PINNED_PARAM);
  else params.set(PINNED_PARAM, "1");
  return (
    <ScopeTabs
      label="Rows to show"
      tabs={[
        {
          icon: Pin,
          label: "Pinned only",
          on: props.on,
          search: params.toString(),
        },
      ]}
    />
  );
}
