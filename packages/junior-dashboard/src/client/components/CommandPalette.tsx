import {
  LockKeyhole,
  MessageSquare,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import fuzzysort from "fuzzysort";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useConversationsData } from "../api";
import { formatCompactAge } from "../conversations/conversationAge";
import {
  NEW_CONVERSATION_PATH,
  conversationPath,
} from "../conversations/conversationRoutes";
import { useDebouncedValue } from "../debouncedValue";
import { buildConversations, conversationDisplayTitle } from "../format";
import { isPlatformShortcut, platformShortcut } from "../keyboard";
import type { Conversation } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
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
  to: string;
};

/**
 * Switch conversations and jump to dashboard pages from anywhere, like an
 * editor's quick open. Owns the global ⌘K / Ctrl+K shortcut; triggers in the
 * shell call `onOpenChange`.
 */
export function CommandPalette(props: {
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
        currentConversationId={props.currentConversationId}
        navItems={props.navItems}
        onClose={() => onOpenChange(false)}
      />
    </CommandDialog>
  );
}

/** Mounted only while open, so the server search runs only then. */
function CommandPaletteBody(props: {
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
  const navigate = useNavigate();
  const list = useRef<HTMLDivElement>(null);
  // Hide server rows until they match the typed text, so stale or
  // placeholder rows never show for the wrong query.
  const searchedCurrent =
    Boolean(search) && query.trim() === search && !searched.isPlaceholderData;
  const items = useMemo(
    () =>
      paletteItems({
        currentConversationId: props.currentConversationId,
        feed: buildConversations(feed.data?.conversations ?? []),
        navItems: props.navItems,
        query: query.trim(),
        searched: searchedCurrent
          ? buildConversations(searched.data?.conversations ?? [])
          : [],
      }),
    [
      feed.data?.conversations,
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
        placeholder="Go to a conversation or page…"
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
                    navigate(item.to);
                    props.onClose();
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

/** Show `label` with the matched characters emphasized. */
function MatchedLabel(props: { label: string; matches?: number[] }) {
  const { label, matches } = props;
  if (!matches?.length) return <>{label}</>;
  const matched = new Set(matches);
  const runs: { chars: string; matched: boolean }[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const isMatched = matched.has(index);
    const last = runs.at(-1);
    if (last?.matched === isMatched) last.chars += label[index];
    else runs.push({ chars: label[index]!, matched: isMatched });
  }
  return runs.map((run, index) =>
    run.matched ? (
      <span className="font-semibold text-dashboard-accent-text" key={index}>
        {run.chars}
      </span>
    ) : (
      run.chars
    ),
  );
}

/**
 * Build palette rows. With no typed text: the most recently active
 * conversations, then pages. With typed text: feed conversations and pages
 * ranked by match, the group with the best match first, then server matches
 * outside the feed. The open conversation is never a row.
 */
function paletteItems(input: {
  currentConversationId?: string;
  feed: Conversation[];
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

  if (!input.query) {
    // The feed puts pins first. Recency puts the last active conversation
    // first, so ⌘K then Enter switches to it.
    const recent = others(input.feed)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, RECENT_LIMIT)
      .map((conversation) => conversationItem(conversation, "Recent"));
    return [...recent, ...pages.map(pageItem)];
  }

  // Sort is stable, so equal scores keep the feed's order.
  const ranked = (rows: PaletteItem[]) =>
    rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  const conversations = ranked(
    others(input.feed).map((conversation) =>
      conversationItem(conversation, "Conversations", input.query),
    ),
  );
  const matchedPages = ranked(
    pages.map((page) => {
      const match = fuzzysort.single(input.query, page.label);
      return {
        ...pageItem(page),
        matches: match ? [...match.indexes] : undefined,
        score: match?.score ?? 0,
      };
    }),
  );
  const shown = new Set(input.feed.map((conversation) => conversation.id));
  const more = others(input.searched)
    .filter((conversation) => !shown.has(conversation.id))
    .slice(0, MORE_LIMIT)
    .map((conversation) =>
      conversationItem(conversation, "More conversations", input.query),
    );
  const pagesFirst =
    (matchedPages[0]?.score ?? 0) > (conversations[0]?.score ?? 0);
  return pagesFirst
    ? [...matchedPages, ...conversations, ...more]
    : [...conversations, ...matchedPages, ...more];
}

function conversationItem(
  conversation: Conversation,
  group: string,
  query?: string,
): PaletteItem {
  const label = conversationDisplayTitle(conversation);
  const match = query ? fuzzysort.single(query, label) : undefined;
  return {
    group,
    icon: conversation.visibility === "private" ? LockKeyhole : MessageSquare,
    id: `conversation-${conversation.id}`,
    label,
    matches: match ? [...match.indexes] : undefined,
    meta: conversation.archivedAt
      ? "Archived"
      : formatCompactAge(conversation.lastSeenAt),
    score: match?.score ?? 0,
    to: conversationPath(conversation.id),
  };
}
