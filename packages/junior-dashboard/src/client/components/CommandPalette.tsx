import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";
import {
  CalendarClock,
  CircleCheck,
  Inbox,
  LockKeyhole,
  MessageSquare,
  SquarePen,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  useAutomationsData,
  useCodeRepositoryConversationsData,
  useConversationsData,
} from "../api";
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
import { inboxViewPath } from "../review-desk/inboxModel";
import { reviewItemPath } from "../review-desk/reviewItemFormat";
import type { Conversation } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { paneTabForPath } from "./layout/PaneNav";
import {
  directoryGroupForPath,
  pluginPageGroupForPath,
  repositoryIdForPath,
  useDirectoryPaletteItems,
} from "./paletteDirectories";
import type { PaletteItem } from "./paletteItem";
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

type PaletteTab = "automations" | "inbox";

// The Inbox tab lists Conversations, so they rank first there.
const TAB_GROUPS: Record<PaletteTab, string> = {
  automations: "Automations",
  inbox: "Conversations",
};

/**
 * The palette group of the page that shows, which ranks first: a
 * directory such as People or Runs, the event log's Events, or the pane
 * tab's group.
 */
export function paletteGroupForPath(
  pathname: string,
  eventLogShown: boolean,
): string | undefined {
  if (eventLogShown) return "Events";
  const tab = paneTabForPath(pathname);
  return directoryGroupForPath(pathname) ?? (tab && TAB_GROUPS[tab]);
}

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
  /** The group of the page that shows, from `paletteGroupForPath`. */
  activeGroup?: string;
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
        activeGroup={props.activeGroup}
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
  activeGroup?: string;
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
  // The list holds the first 100, and the server matches instructions too.
  const automationsSearched = useAutomationsData(
    Boolean(search),
    new URLSearchParams({ pageSize: "20", q: search }).toString(),
  );
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // On a repository page, its matching Conversations lead their group.
  const repositorySearched = useCodeRepositoryConversationsData(
    search ? repositoryIdForPath(pathname) : undefined,
    search,
  );
  // A generic plugin page's rows lead on it, as a directory's do.
  const activeGroup =
    props.activeGroup ?? pluginPageGroupForPath(props.navItems, pathname);
  const directories = useDirectoryPaletteItems({
    activeGroup,
    conversationId: props.currentConversationId,
    navItems: props.navItems,
    pathname,
    query: query.trim(),
    search,
  });
  const list = useRef<HTMLDivElement>(null);
  // Hide server rows until they match the typed text, so stale or
  // placeholder rows never show for the wrong query.
  const searchedCurrent =
    Boolean(search) && query.trim() === search && !searched.isPlaceholderData;
  const inboxSearchedCurrent =
    Boolean(search) &&
    query.trim() === search &&
    !inboxSearched.query.isPlaceholderData;
  const automationsSearchedCurrent =
    Boolean(search) &&
    query.trim() === search &&
    !automationsSearched.isPlaceholderData;
  const repositorySearchedCurrent =
    Boolean(search) &&
    query.trim() === search &&
    !repositorySearched.isPlaceholderData;
  const items = useMemo(
    () =>
      paletteItems({
        actions: props.actions,
        activeGroup,
        automations: automations.data?.automations ?? [],
        automationsSearched: automationsSearchedCurrent
          ? (automationsSearched.data?.automations ?? [])
          : [],
        currentConversationId: props.currentConversationId,
        directories,
        feed: buildConversations(feed.data?.conversations ?? []),
        inbox: inbox.items,
        inboxSearched: inboxSearchedCurrent ? inboxSearched.items : [],
        navItems: props.navItems,
        query: query.trim(),
        repositorySearched: repositorySearchedCurrent
          ? buildConversations(repositorySearched.data?.conversations ?? [])
          : [],
        searched: searchedCurrent
          ? buildConversations(searched.data?.conversations ?? [])
          : [],
      }),
    [
      automations.data?.automations,
      automationsSearched.data?.automations,
      automationsSearchedCurrent,
      feed.data?.conversations,
      inbox.items,
      inboxSearched.items,
      inboxSearchedCurrent,
      directories,
      activeGroup,
      props.actions,
      props.currentConversationId,
      props.navItems,
      query,
      repositorySearched.data?.conversations,
      repositorySearchedCurrent,
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
        placeholder="Search conversations, Inbox, automations, and more…"
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
  activeGroup?: string;
  automations: AutomationSummary[];
  /** Server matches on title, instruction, skill, and resource. */
  automationsSearched: AutomationSummary[];
  currentConversationId?: string;
  /** Directory rows, already matched and ranked. */
  directories: PaletteItem[];
  feed: Conversation[];
  inbox: ReviewItemPayload[];
  /** Server matches on title and body. */
  inboxSearched: ReviewItemPayload[];
  navItems: DashboardHeaderNavItem[];
  query: string;
  /** Server matches linked to the open repository page. */
  repositorySearched: Conversation[];
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
  // The page's rows lead, under its group's name. A tab names its rows;
  // a directory's are its group.
  const lead = (
    tabRows: Record<string, PaletteItem[]>,
    rest: PaletteItem[][],
  ) => {
    const all = [...rest.flat(), ...input.directories];
    const group = input.activeGroup;
    if (!group) return all;
    const first = (
      tabRows[group] ?? all.filter((row) => row.group === group)
    ).map((row) => ({ ...row, group }));
    return [
      ...first,
      ...all.filter((row) => !first.some((item) => item.id === row.id)),
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
        Automations: automations.slice(0, RECENT_LIMIT),
        Conversations: recent,
        Inbox: inbox.slice(0, RECENT_LIMIT),
      },
      [recent, input.actions.map(actionItem), pages.map(pageItem)],
    );
  }

  // Sort is stable, so equal scores keep the feed's order.
  const ranked = (rows: PaletteItem[]) =>
    rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  // The open repository's matches lead; the server matched them on more
  // than the title, so each one stays.
  const inRepository = new Set(
    input.repositorySearched.map((conversation) => conversation.id),
  );
  const conversations = [
    ...others(input.repositorySearched).map((conversation) => {
      const item = conversationItem(conversation, "Conversations", query);
      return { ...item, score: Math.max(item.score, 1) };
    }),
    ...ranked(
      others(input.feed)
        .filter((conversation) => !inRepository.has(conversation.id))
        .map((conversation) =>
          conversationItem(conversation, "Conversations", query),
        ),
    ),
  ];
  const matchedPages = ranked(
    [...input.actions.map(actionItem), ...pages.map(pageItem)].map((item) => {
      const match = quickOpenMatch(item.label, query);
      return { ...item, matches: match?.indices, score: match?.score ?? 0 };
    }),
  );
  const shown = new Set([
    ...input.feed.map((conversation) => conversation.id),
    ...inRepository,
  ]);
  const more = others(input.searched)
    .filter((conversation) => !shown.has(conversation.id))
    .slice(0, MORE_LIMIT)
    .map((conversation) =>
      conversationItem(conversation, "More conversations", query),
    );
  // Title matches in the cached list rank first; server matches on other
  // text, or past the list, follow.
  const withServerMatches = (local: PaletteItem[], server: PaletteItem[]) =>
    [
      ...local,
      ...server.filter((row) => !local.some((item) => item.id === row.id)),
    ].slice(0, MORE_LIMIT);
  // Closed matches open in Done, after the open ones.
  const matchedInbox = withServerMatches(
    ranked(inbox),
    input.inboxSearched
      .filter((item) => item.status === "open")
      .map((item) => inboxItem(item, query)),
  );
  const matchedDone = input.inboxSearched
    .filter((item) => item.status !== "open")
    .slice(0, MORE_LIMIT)
    .map((item) => doneItem(item, query));
  const matchedAutomations = withServerMatches(
    ranked(automations),
    input.automationsSearched.map((automation) =>
      automationItem(automation, query),
    ),
  );
  const pagesFirst =
    (matchedPages[0]?.score ?? 0) > (conversations[0]?.score ?? 0);
  return lead(
    {
      Automations: matchedAutomations,
      Conversations: conversations,
      Inbox: matchedInbox,
    },
    [
      ...(pagesFirst
        ? [matchedPages, conversations]
        : [conversations, matchedPages]),
      matchedInbox,
      matchedDone,
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

function doneItem(item: ReviewItemPayload, query?: string): PaletteItem {
  const match = query ? quickOpenMatch(item.title, query) : undefined;
  return {
    group: "Done",
    icon: CircleCheck,
    id: `done-item-${item.id}`,
    label: item.title,
    matches: match?.indices,
    // The server matched the text, so the row stays without a title match.
    score: match?.score ?? 1,
    to: inboxViewPath("done", { itemId: item.id }),
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
