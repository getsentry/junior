import type { InboxItemPayload } from "@sentry/junior/api/schema";
import {
  Check,
  CircleHelp,
  Ellipsis,
  Eye,
  GitPullRequest,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  Pin,
  type LucideIcon,
} from "lucide-react";

import { ScopeTabs, type ScopeTab } from "../components/filters/ScopeTabs";
import { conversationDisplayState } from "../conversations/ConversationStateIcon";
import type { Conversation } from "../types";
import {
  isCodeChangeItem,
  isDecisionItem,
  isTodoItem,
  type InboxView,
} from "./inboxModel";

/**
 * The type of an ask, as the Inbox filters split them. A pull request ask
 * is a Pull request even when it asks a question. Other holds the rest,
 * such as text questions and Resume.
 */
export type AskType = "decisions" | "other" | "prs" | "todos";

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

// All, the default, sits at the right edge, and Pinned just before it. The
// tab order follows the order on screen.
const TYPE_FILTERS: readonly Filter<InboxTypeFilter>[] = [
  { icon: Ellipsis, key: "other", label: "Other" },
  { icon: GitPullRequest, key: "prs", label: "PRs" },
  { icon: MessageCircleQuestion, key: "decisions", label: "Decisions" },
  { icon: ListTodo, key: "todos", label: "To-dos" },
  { key: "all", label: "All" },
];

const STATE_FILTERS: readonly Filter<ConversationStateFilter>[] = [
  { icon: Check, key: "done", label: "Done" },
  { icon: Eye, key: "watching", label: "Watching" },
  { icon: LoaderCircle, key: "working", label: "Working" },
  { icon: CircleHelp, key: "needs_you", label: "Needs you" },
  { key: "all", label: "All" },
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

/**
 * Link each filter to the search that turns it on; All clears the param.
 * A filter turns Pinned off, as one control holds them all.
 */
function filterTabs<Key extends string>(
  filters: readonly Filter<Key>[],
  param: string,
  search: string,
  on: Key | undefined,
) {
  return filters.map((filter) => {
    const params = filterSearch(search);
    params.delete(PINNED_PARAM);
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

/**
 * Add the Pinned tab just before All. It shows only the viewer's pinned
 * Conversations and turns the other filters off.
 */
function withPinnedTab(
  tabs: readonly (ScopeTab & { key: string })[],
  search: string,
  on: boolean,
): ScopeTab[] {
  const params = filterSearch(search);
  params.delete(TYPE_PARAM);
  params.delete(STATE_PARAM);
  params.set(PINNED_PARAM, "1");
  const pinned: ScopeTab = {
    icon: Pin,
    iconOnlyOnPhone: true,
    label: "Pinned",
    on,
    search: params.toString(),
  };
  return tabs.flatMap((tab) => (tab.key === "all" ? [pinned, tab] : [tab]));
}

/** Say which type an ask is. */
export function askTypeOf(item: InboxItemPayload): AskType {
  if (isCodeChangeItem(item)) return "prs";
  if (isDecisionItem(item)) return "decisions";
  if (isTodoItem(item)) return "todos";
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
 * asks that wait on the viewer, or only the pinned rows. A type with
 * nothing waiting hides, unless it is on; All and Pinned always show.
 */
function InboxTypeFilters(props: {
  counts: Partial<Record<InboxTypeFilter, number>>;
  pinned: boolean;
  search: string;
  type: InboxTypeFilter;
}) {
  const tabs = filterTabs(
    TYPE_FILTERS,
    TYPE_PARAM,
    props.search,
    props.pinned ? undefined : props.type,
  )
    .filter(
      // An unknown count, before the server totals load, does not hide a
      // type.
      (tab) => tab.key === "all" || tab.on || props.counts[tab.key] !== 0,
    )
    .map((tab) => ({
      ...tab,
      count: props.counts[tab.key],
      iconOnlyOnPhone: true,
    }));
  return (
    <ScopeTabs
      label="Asks to show"
      tabs={withPinnedTab(tabs, props.search, props.pinned)}
    />
  );
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
  const pinnedOnly =
    filters &&
    signedIn &&
    (view === "inbox" || view === "conversations") &&
    pinnedOnlyOf(search);
  const others = filters && !pinnedOnly;
  return {
    conversationState:
      others && view === "conversations" ? conversationStateOf(search) : "all",
    pinnedOnly,
    type: others && signedIn && view === "inbox" ? inboxTypeOf(search) : "all",
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

/**
 * Pick the viewer state of the Conversations that a list shows, or only the
 * pinned ones. Without `pinned`, the list has no Pinned tab.
 */
export function ConversationStateFilters(props: {
  pinned?: boolean;
  search: string;
  state: ConversationStateFilter;
}) {
  const tabs = filterTabs(
    STATE_FILTERS,
    STATE_PARAM,
    props.search,
    props.pinned ? undefined : props.state,
  ).map((tab) => ({ ...tab, iconOnlyOnPhone: true }));
  return (
    <ScopeTabs
      label="Conversations to show"
      tabs={
        props.pinned === undefined
          ? tabs
          : withPinnedTab(tabs, props.search, props.pinned)
      }
    />
  );
}

/**
 * The filters of an Inbox list view, as one control: the types in the
 * Inbox, the states in Conversations, and Pinned in both.
 */
export function ListFilters(props: {
  conversationState: ConversationStateFilter;
  counts: Partial<Record<InboxTypeFilter, number>>;
  pinnedOnly: boolean;
  search: string;
  signedIn: boolean;
  type: InboxTypeFilter;
  view: InboxView;
}) {
  if (props.view === "inbox") {
    return props.signedIn ? (
      <InboxTypeFilters
        counts={props.counts}
        pinned={props.pinnedOnly}
        search={props.search}
        type={props.type}
      />
    ) : null;
  }
  return props.view === "conversations" ? (
    <ConversationStateFilters
      pinned={props.signedIn ? props.pinnedOnly : undefined}
      search={props.search}
      state={props.conversationState}
    />
  ) : null;
}

/** Say whether an Inbox list view has filters. */
export function hasListFilters(view: InboxView, signedIn: boolean): boolean {
  return view === "conversations" || (view === "inbox" && signedIn);
}
