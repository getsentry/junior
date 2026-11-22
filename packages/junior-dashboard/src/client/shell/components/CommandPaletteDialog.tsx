import type {
  AutomationListItem,
  InboxItemPayload,
} from "@sentry/junior/api/schema";
import { cn, dashboardCountClass } from "../../styles";
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

import {
  COMMAND_PALETTE_LABEL,
  type CommandPaletteProps,
  type PaletteAction,
} from "./CommandPalette";
import { useLocation, useNavigate } from "react-router";

import {
  useAutomationsData,
  useCodeRepositoryConversationsData,
  useConversationsData,
  useDashboardCoreData,
} from "../../api";
import {
  FOCUS_REPLY_STATE,
  COMPOSER_PATH,
  conversationPath,
} from "../../conversations/conversationRoutes";
import { useDebouncedValue } from "../../debouncedValue";
import { buildConversations, conversationDisplayTitle } from "../../format";
import { paletteNavPages, type PalettePage } from "../../navPages";
import {
  AUTOMATION_LIST_SEARCH,
  automationSelectPath,
} from "../../pages/automations/newAutomation";
import { useInboxItemsData } from "../../inbox/queries";
import { inboxViewPath } from "../../inbox/inboxModel";
import { inboxRowPath } from "../../inbox/inboxItemFormat";
import type { Conversation } from "../../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "../../components/layout/navIcons";
import {
  pluginPageGroupForPath,
  repositoryIdForPath,
  useDirectoryPaletteItems,
} from "../../components/paletteDirectories";
import type { PaletteItem } from "../../components/paletteItem";
import { MatchedLabel } from "../../components/MatchedLabel";
import { quickOpenMatch } from "../../components/quickOpenMatch";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import { Kbd } from "../../components/ui/kbd";
import { formatCompactAge } from "../../time";
import { fadeTextClass } from "../../textFade";

/** A page row before it is matched: a nav item or another page. */
type PageRow = {
  icon: LucideIcon;
  key: string;
  label: string;
  /** The page's area, such as Settings for API Tokens. */
  meta?: string | undefined;
  state?: typeof FOCUS_REPLY_STATE;
  to: string;
};

const RECENT_LIMIT = 8;
const MORE_LIMIT = 8;

/**
 * The command palette's dialog and rows. It loads with the first open, so
 * cmdk stays out of the first load.
 */
export function CommandPaletteDialog(props: CommandPaletteProps) {
  const { onOpenChange } = props;
  return (
    <CommandDialog
      onOpenChange={onOpenChange}
      open={props.open}
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
  // The Inbox's own list, so the palette reads its cache.
  const inbox = useInboxItemsData({ forViewer: true, sort: "waiting" });
  // The server matches body text too, which the cached list cannot.
  const inboxSearched = useInboxItemsData({
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
  const viewer = useDashboardCoreData().data?.me.user;
  const navPages = useMemo(
    () =>
      paletteNavPages({
        email: viewer?.email,
        isAdmin: viewer?.isAdmin === true,
        navItems: props.navItems,
      }),
    [props.navItems, viewer?.email, viewer?.isAdmin],
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
        directories: directories.items,
        feed: buildConversations(feed.data?.conversations ?? []),
        inbox: inbox.items,
        inboxSearched: inboxSearchedCurrent ? inboxSearched.items : [],
        navItems: props.navItems,
        navPages,
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
      directories.items,
      navPages,
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
  // Every server read counts, so "No matches." never shows while one of
  // them can still match.
  const searching =
    query.trim() !== search ||
    [
      searched,
      inboxSearched.query,
      automationsSearched,
      repositorySearched,
    ].some((read) => read.isFetching) ||
    directories.fetching;

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
        <Kbd className="max-sm:hidden">esc</Kbd>
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
                    else void navigate(item.to, { state: item.state });
                  }}
                  value={item.id}
                >
                  <Icon aria-hidden="true" />
                  <span className={cn(fadeTextClass, "flex-1")}>
                    <MatchedLabel label={item.label} matches={item.matches} />
                  </span>
                  {item.meta ? (
                    <span className={cn("text-xs", dashboardCountClass)}>
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
  automations: AutomationListItem[];
  /** Server matches on title, instruction, skill, and resource. */
  automationsSearched: AutomationListItem[];
  currentConversationId?: string;
  /** Directory rows, already matched and ranked. */
  directories: PaletteItem[];
  feed: Conversation[];
  inbox: InboxItemPayload[];
  /** Server matches on title and body. */
  inboxSearched: InboxItemPayload[];
  navItems: DashboardHeaderNavItem[];
  /** Pages outside the nav items, which list once the viewer types. */
  navPages: PalettePage[];
  query: string;
  /** Server matches linked to the open repository page. */
  repositorySearched: Conversation[];
  searched: Conversation[];
}): PaletteItem[] {
  const others = (conversations: Conversation[]) =>
    conversations.filter(
      (conversation) => conversation.id !== input.currentConversationId,
    );
  const pages: PageRow[] = [
    {
      icon: SquarePen,
      key: "new-conversation",
      label: "New conversation",
      state: FOCUS_REPLY_STATE,
      to: COMPOSER_PATH,
    },
    ...input.navItems.map((item) => ({
      icon: navItemIcon(item.key),
      key: item.key,
      label: item.label,
      to: item.to,
    })),
    // Every other page waits for typed text, so the empty palette stays short.
    ...(input.query
      ? input.navPages.map((page) => ({
          icon: navItemIcon(page.area?.key ?? page.key),
          key: page.key,
          label: page.label,
          meta: page.area?.label,
          to: page.to,
        }))
      : []),
  ];
  const pageItem = (page: PageRow): PaletteItem => ({
    group: "Go to",
    icon: page.icon,
    id: `page-${page.key}`,
    label: page.label,
    meta: page.meta,
    score: 0,
    state: page.state,
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

function inboxItem(item: InboxItemPayload, query?: string): PaletteItem {
  const match = query ? quickOpenMatch(item.title, query) : undefined;
  return {
    group: "Inbox",
    icon: Inbox,
    id: `inbox-item-${item.id}`,
    label: item.title,
    matches: match?.indices,
    score: match?.score ?? 0,
    to: inboxRowPath(item),
  };
}

function doneItem(item: InboxItemPayload, query?: string): PaletteItem {
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
  automation: AutomationListItem,
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
