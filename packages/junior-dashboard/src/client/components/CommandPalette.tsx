import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";
import {
  CalendarClock,
  Inbox,
  LockKeyhole,
  MessageSquare,
  SquarePen,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useAutomationsData, useConversationsData } from "../api";
import { formatCompactAge } from "../conversations/conversationAge";
import {
  FOCUS_REPLY_STATE,
  NEW_CONVERSATION_PATH,
  conversationPath,
} from "../conversations/conversationRoutes";
import { useDebouncedValue } from "../debouncedValue";
import { buildConversations, conversationDisplayTitle } from "../format";
import { isPlatformShortcut, platformShortcut } from "../keyboard";
import {
  AUTOMATION_LIST_SEARCH,
  automationSelectPath,
} from "../pages/automations/AutomationSidebarList";
import { useReviewItemsData } from "../review-desk/queries";
import { reviewItemPath } from "../review-desk/reviewItemFormat";
import type { Conversation } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { MatchedLabel } from "./MatchedLabel";
import { quickOpenMatch } from "./quickOpenMatch";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

const RECENT_LIMIT = 8;
const MORE_LIMIT = 8;

/** Shortcut text for command palette triggers on this platform. */
export const COMMAND_PALETTE_SHORTCUT = platformShortcut("k");

/** Name of the command palette and the controls that open it. */
export const COMMAND_PALETTE_LABEL = "Go to conversation";

type PaletteItem = {
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

/** The pane tab that shows, whose results rank first. */
export type PaletteTab = "automations" | "conversations" | "inbox";

const TAB_GROUPS: Record<PaletteTab, string> = {
  automations: "Automations",
  conversations: "Conversations",
  inbox: "Inbox",
};

/** A command that acts on the page, such as Zen mode, rather than going somewhere. */
type PaletteAction = {
  icon: LucideIcon;
  id: string;
  label: string;
  /** Shortcut text, such as `⌥⌘Y`. */
  shortcut?: string;
  run(): void;
};

/**
 * Switch conversations and jump to dashboard pages from anywhere, like an
 * editor's quick open. Owns the global ⌘K / Ctrl+K shortcut; triggers in the
 * shell call `onOpenChange`.
 */
export function CommandPalette(props: {
  actions?: PaletteAction[];
  activeTab?: PaletteTab;
  /** Left out of the rows: the viewer is already there. */
  currentConversationId?: string;
  navItems: DashboardHeaderNavItem[];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { onOpenChange, open } = props;
  useEffect(() => {
    const toggle = (event: globalThis.KeyboardEvent) => {
      if (!isPlatformShortcut(event, "k") || event.repeat) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [onOpenChange, open]);

  return (
    <CommandDialog
      onOpenChange={onOpenChange}
      open={open}
      title={COMMAND_PALETTE_LABEL}
    >
      <CommandPaletteBody
        actions={props.actions ?? []}
        activeTab={props.activeTab}
        currentConversationId={props.currentConversationId}
        navItems={props.navItems}
        onClose={() => onOpenChange(false)}
      />
    </CommandDialog>
  );
}

/** Mounted only while open, so the server search runs only then. */
function CommandPaletteBody(props: {
  actions: PaletteAction[];
  activeTab?: PaletteTab;
  currentConversationId?: string;
  navItems: DashboardHeaderNavItem[];
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim());
  // The shell already holds the feed, so rows filter on each keystroke with
  // no request. The server search only reaches conversations outside it.
  const feed = useConversationsData();
  const searched = useConversationsData(search);
  const inbox = useReviewItemsData({ forViewer: true });
  // The server matches body text too, which the cached list cannot.
  const inboxSearched = useReviewItemsData({
    enabled: Boolean(search),
    forViewer: true,
    q: search,
  });
  const automations = useAutomationsData(true, AUTOMATION_LIST_SEARCH);
  const navigate = useNavigate();
  const list = useRef<HTMLDivElement>(null);
  // Hide server rows until they match the typed text, so stale or
  // placeholder rows never show for the wrong query.
  const searchedCurrent =
    Boolean(search) && query.trim() === search && !searched.isPlaceholderData;
  const inboxSearchedCurrent =
    Boolean(search) &&
    query.trim() === search &&
    !inboxSearched.query.isPlaceholderData;
  const items = useMemo(
    () =>
      paletteItems({
        actions: props.actions,
        activeTab: props.activeTab,
        automations: automations.data?.automations ?? [],
        currentConversationId: props.currentConversationId,
        feed: buildConversations(feed.data?.conversations ?? []),
        inbox: inbox.items,
        inboxSearched: inboxSearchedCurrent ? inboxSearched.items : [],
        navItems: props.navItems,
        query: query.trim(),
        searched: searchedCurrent
          ? buildConversations(searched.data?.conversations ?? [])
          : [],
      }),
    [
      automations.data?.automations,
      feed.data?.conversations,
      inbox.items,
      inboxSearched.items,
      inboxSearchedCurrent,
      props.actions,
      props.activeTab,
      props.currentConversationId,
      props.navItems,
      query,
      searched.data?.conversations,
      searchedCurrent,
    ],
  );
  // cmdk keeps the highlight on its row when rows load above it, but scrolls
  // only on key moves. Keep the highlight in view when rows change.
  useEffect(() => {
    list.current
      ?.querySelector('[cmdk-item][data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [items]);

  const groups = [...new Set(items.map((item) => item.group))].map(
    (group) => [group, items.filter((item) => item.group === group)] as const,
  );
  const searching = query.trim() !== search || searched.isFetching;

  return (
    // Rows are already filtered and ranked in `paletteItems`.
    <Command loop shouldFilter={false} vimBindings={false}>
      <CommandInput
        aria-label="Conversation or page"
        onValueChange={setQuery}
        placeholder="Search conversations, Inbox, automations, and pages…"
        spellCheck={false}
        value={query}
      >
        <kbd className="shrink-0 rounded border border-dashboard-border px-1.5 py-0.5 font-sans text-xs text-dashboard-text-faint max-sm:hidden">
          esc
        </kbd>
      </CommandInput>
      <CommandList ref={list}>
        <CommandEmpty>{searching ? "Searching…" : "No matches."}</CommandEmpty>
        {groups.map(([group, groupItems]) => (
          <CommandGroup heading={group} key={group}>
            {groupItems.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.id}
                  onSelect={() => {
                    props.onClose();
                    if (item.run) item.run();
                    else navigate(item.to, { state: item.state });
                  }}
                  value={item.id}
                >
                  <Icon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    <MatchedLabel label={item.label} matches={item.matches} />
                  </span>
                  {item.meta ? (
                    <span className="text-xs tabular-nums text-dashboard-text-faint">
                      {item.meta}
                    </span>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

/**
 * Build palette rows. The active tab's results come first, under its name.
 * With no typed text: recent rows of that tab, then the most recently
 * active conversations, actions, and pages. With typed text: matches of
 * each kind, ranked; conversations and pages put the group with the best
 * match first, then Inbox items, automations, and server matches outside
 * the feed. The open conversation is never a row.
 */
function paletteItems(input: {
  actions: PaletteAction[];
  activeTab?: PaletteTab;
  automations: AutomationSummary[];
  currentConversationId?: string;
  feed: Conversation[];
  inbox: ReviewItemPayload[];
  /** Server matches on title and body. */
  inboxSearched: ReviewItemPayload[];
  navItems: DashboardHeaderNavItem[];
  query: string;
  searched: Conversation[];
}): PaletteItem[] {
  const others = (conversations: Conversation[]) =>
    conversations.filter(
      (conversation) => conversation.id !== input.currentConversationId,
    );
  const pages = [
    {
      icon: SquarePen,
      key: "new-conversation",
      label: "New conversation",
      to: NEW_CONVERSATION_PATH,
    },
    ...input.navItems.map((item) => ({
      icon: navItemIcon(item.key),
      key: item.key,
      label: item.label,
      to: item.to,
    })),
  ];
  const pageItem = (page: (typeof pages)[number]): PaletteItem => ({
    group: "Go to",
    icon: page.icon,
    id: `page-${page.key}`,
    label: page.label,
    score: 0,
    to: page.to,
  });
  const actionItem = (action: PaletteAction): PaletteItem => ({
    group: "Actions",
    icon: action.icon,
    id: `action-${action.id}`,
    label: action.label,
    meta: action.shortcut,
    run: action.run,
    score: 0,
  });
  const query = input.query || undefined;
  const inbox = input.inbox.map((item) => inboxItem(item, query));
  const automations = input.automations.map((automation) =>
    automationItem(automation, query),
  );
  // The active tab's rows lead, under the tab's name.
  const lead = (
    rows: Record<PaletteTab, PaletteItem[]>,
    rest: PaletteItem[][],
  ) => {
    const tab = input.activeTab;
    if (!tab) return rest.flat();
    const first = rows[tab].map((row) => ({ ...row, group: TAB_GROUPS[tab] }));
    return [
      ...first,
      ...rest.flat().filter((row) => !first.some((item) => item.id === row.id)),
    ];
  };

  if (!query) {
    // The feed puts pins first. Recency puts the last active conversation
    // first, so ⌘K then Enter switches to it.
    const recent = others(input.feed)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, RECENT_LIMIT)
      .map((conversation) => conversationItem(conversation, "Recent"));
    return lead(
      {
        automations: automations.slice(0, RECENT_LIMIT),
        conversations: recent,
        inbox: inbox.slice(0, RECENT_LIMIT),
      },
      [recent, input.actions.map(actionItem), pages.map(pageItem)],
    );
  }

  // Sort is stable, so equal scores keep the feed's order.
  const ranked = (rows: PaletteItem[]) =>
    rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  const conversations = ranked(
    others(input.feed).map((conversation) =>
      conversationItem(conversation, "Conversations", query),
    ),
  );
  const matchedPages = ranked(
    [...input.actions.map(actionItem), ...pages.map(pageItem)].map((item) => {
      const match = quickOpenMatch(item.label, query);
      return { ...item, matches: match?.indices, score: match?.score ?? 0 };
    }),
  );
  const shown = new Set(input.feed.map((conversation) => conversation.id));
  const more = others(input.searched)
    .filter((conversation) => !shown.has(conversation.id))
    .slice(0, MORE_LIMIT)
    .map((conversation) =>
      conversationItem(conversation, "More conversations", query),
    );
  // Title matches rank first; server matches on body text follow. The
  // Inbox opens only open items, so closed matches stay out.
  const titleMatched = ranked(inbox);
  const matchedInbox = [
    ...titleMatched,
    ...input.inboxSearched
      .filter(
        (item) =>
          item.status === "open" &&
          !titleMatched.some((row) => row.id === `review-item-${item.id}`),
      )
      .map((item) => inboxItem(item, query)),
  ].slice(0, MORE_LIMIT);
  const matchedAutomations = ranked(automations).slice(0, MORE_LIMIT);
  const pagesFirst =
    (matchedPages[0]?.score ?? 0) > (conversations[0]?.score ?? 0);
  return lead(
    {
      automations: matchedAutomations,
      conversations,
      inbox: matchedInbox,
    },
    [
      ...(pagesFirst
        ? [matchedPages, conversations]
        : [conversations, matchedPages]),
      matchedInbox,
      matchedAutomations,
      more,
    ],
  );
}

function inboxItem(item: ReviewItemPayload, query?: string): PaletteItem {
  const match = query ? quickOpenMatch(item.title, query) : undefined;
  return {
    group: "Inbox",
    icon: Inbox,
    id: `review-item-${item.id}`,
    label: item.title,
    matches: match?.indices,
    score: match?.score ?? 0,
    to: reviewItemPath(item.id),
  };
}

function automationItem(
  automation: AutomationSummary,
  query?: string,
): PaletteItem {
  const match = query ? quickOpenMatch(automation.title, query) : undefined;
  return {
    group: "Automations",
    icon: automation.kind === "scheduled" ? CalendarClock : Zap,
    id: `automation-${automation.id}`,
    label: automation.title,
    matches: match?.indices,
    score: match?.score ?? 0,
    to: automationSelectPath(automation),
  };
}

function conversationItem(
  conversation: Conversation,
  group: string,
  query?: string,
): PaletteItem {
  const label = conversationDisplayTitle(conversation);
  const match = query ? quickOpenMatch(label, query) : undefined;
  return {
    group,
    icon: conversation.visibility === "private" ? LockKeyhole : MessageSquare,
    id: `conversation-${conversation.id}`,
    label,
    matches: match?.indices,
    meta: conversation.archivedAt
      ? "Archived"
      : formatCompactAge(conversation.lastSeenAt),
    score: match?.score ?? 0,
    // The reader switched there to talk, so the reply box takes focus.
    state: FOCUS_REPLY_STATE,
    to: conversationPath(conversation.id),
  };
}
