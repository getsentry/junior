import type { InboxItemPayload } from "@sentry/junior/api/schema";
import {
  Check,
  CircleHelp,
  Eye,
  LoaderCircle,
  Pin,
  type LucideIcon,
} from "lucide-react";

import { ScopeTabs } from "../components/filters/ScopeTabs";
import { conversationDisplayState } from "../conversations/ConversationStateIcon";
import type { Conversation } from "../types";
import { isCodeChangeItem, isDecisionItem, type InboxView } from "./inboxModel";

/**
 * The type of an ask, as the Inbox filters split them. A pull request ask
 * is a Pull request even when it asks a question. Other holds the rest,
 * such as To-dos, text questions, and Resume.
 */
export type AskType = "decisions" | "other" | "prs";

/** The Inbox filter: every ask, or the asks of one type. */
export type InboxTypeFilter = AskType | "all";

/**
 * The Conversation filter: every Conversation, or the ones in one viewer
 * state, as their row icons show it.
 */
export type ConversationStateFilter =
  | "all"
  | "done"
  | "needs_you"
  | "watching"
  | "working";

type Filter<Key extends string> = {
  icon?: LucideIcon;
  key: Key;
  label: string;
};

const TYPE_PARAM = "type";
const STATE_PARAM = "state";
const PINNED_PARAM = "pinned";

const TYPE_FILTERS: readonly Filter<InboxTypeFilter>[] = [
  { key: "all", label: "All" },
  { key: "prs", label: "PRs" },
  { key: "decisions", label: "Decisions" },
  { key: "other", label: "Other" },
];

const STATE_FILTERS: readonly Filter<ConversationStateFilter>[] = [
  { key: "all", label: "All" },
  { icon: CircleHelp, key: "needs_you", label: "Needs you" },
  { icon: LoaderCircle, key: "working", label: "Working" },
  { icon: Eye, key: "watching", label: "Watching" },
  { icon: Check, key: "done", label: "Done" },
];

/**
 * Copy the current search for a filter link. A filter leaves the one-time
 * `item` link, so the list does not wait on a row that the filter hides.
 */
function filterSearch(search: string) {
  const params = new URLSearchParams(search);
  params.delete("item");
  return params;
}

/**
 * Take the filters out of a list path, so a linked row that a filter would
 * hide stays on screen once the `item` link leaves the URL.
 */
export function withoutFilters(path: string): string {
  const [pathname, search = ""] = path.split("?", 2);
  const params = new URLSearchParams(search);
  for (const param of [TYPE_PARAM, STATE_PARAM, PINNED_PARAM]) {
    params.delete(param);
  }
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : (pathname ?? path);
}

/** Link each filter to the search that turns it on; All clears the param. */
function filterTabs<Key extends string>(
  filters: readonly Filter<Key>[],
  param: string,
  search: string,
  on: Key,
) {
  return filters.map((filter) => {
    const params = filterSearch(search);
    if (filter.key === "all") params.delete(param);
    else params.set(param, filter.key);
    return {
      icon: filter.icon,
      key: filter.key,
      label: filter.label,
      on: filter.key === on,
      search: params.toString(),
    };
  });
}

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
  const tabs = filterTabs(TYPE_FILTERS, TYPE_PARAM, props.search, props.type)
    .filter(
      // An unknown count, before the server totals load, does not hide a
      // type.
      (tab) => tab.key === "all" || tab.on || props.counts[tab.key] !== 0,
    )
    .map((tab) => ({ ...tab, count: props.counts[tab.key] }));
  return <ScopeTabs label="Asks to show" tabs={tabs} />;
}

/** Read the Conversation state filter from `?state=`. Other values show All. */
export function conversationStateOf(
  search: URLSearchParams,
): ConversationStateFilter {
  const value = search.get(STATE_PARAM);
  return STATE_FILTERS.find((filter) => filter.key === value)?.key ?? "all";
}

/**
 * Read the filters of an Inbox list view from the URL. A one-time `?item=`
 * link shows every row, so no filter hides its row.
 */
export function listFiltersOf(
  search: URLSearchParams,
  view: InboxView,
  signedIn: boolean,
): {
  conversationState: ConversationStateFilter;
  pinnedOnly: boolean;
  type: InboxTypeFilter;
} {
  const filters = !search.has("item");
  return {
    conversationState:
      filters && view === "conversations" ? conversationStateOf(search) : "all",
    pinnedOnly:
      filters &&
      signedIn &&
      (view === "inbox" || view === "conversations") &&
      pinnedOnlyOf(search),
    type: filters && signedIn && view === "inbox" ? inboxTypeOf(search) : "all",
  };
}

/**
 * Say whether a Conversation is in a state, as its row shows it. Needs you
 * is an ask that waits on the viewer, `waitsOnViewer`, or a tree that needs
 * them. Done is a tree with nothing running, watching, or waiting on the
 * viewer, also when it is pinned.
 */
export function inConversationState(
  conversation: Conversation | undefined,
  waitsOnViewer: boolean,
  state: ConversationStateFilter,
): boolean {
  if (state === "all") return true;
  const shown = conversation
    ? conversationDisplayState(conversation)
    : undefined;
  const current =
    waitsOnViewer || shown === "needs_you"
      ? "needs_you"
      : shown === "working" || shown === "watching"
        ? shown
        : "done";
  return current === state;
}

/** Pick the viewer state of the Conversations that a list shows. */
export function ConversationStateFilters(props: {
  search: string;
  state: ConversationStateFilter;
}) {
  return (
    <ScopeTabs
      label="Conversations to show"
      tabs={filterTabs(
        STATE_FILTERS,
        STATE_PARAM,
        props.search,
        props.state,
      ).map((tab) => ({ ...tab, iconOnlyOnPhone: true }))}
    />
  );
}

/**
 * Switch between every row and only the viewer's pinned Conversations, as
 * one All / Pinned control.
 */
export function PinnedFilter(props: { on: boolean; search: string }) {
  const all = filterSearch(props.search);
  all.delete(PINNED_PARAM);
  const pinned = filterSearch(props.search);
  pinned.set(PINNED_PARAM, "1");
  return (
    <ScopeTabs
      label="Rows to show"
      tabs={[
        { label: "All", on: !props.on, search: all.toString() },
        {
          icon: Pin,
          iconOnlyOnPhone: true,
          label: "Pinned",
          on: props.on,
          search: pinned.toString(),
        },
      ]}
    />
  );
}
