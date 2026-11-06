import {
  LockKeyhole,
  MessageSquare,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
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

const RECENT_LIMIT = 5;
const RESULT_LIMIT = 8;

const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Shortcut text for command palette triggers on this platform. */
export const COMMAND_PALETTE_SHORTCUT = isApple ? "⌘K" : "Ctrl K";

type PaletteItem = {
  group: string;
  icon: LucideIcon;
  id: string;
  label: string;
  meta?: string;
  to: string;
};

/**
 * Search conversations and jump to dashboard pages from anywhere. Owns the
 * global ⌘K / Ctrl+K shortcut; triggers in the shell call `onOpenChange`.
 */
export function CommandPalette(props: {
  navItems: DashboardHeaderNavItem[];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { onOpenChange, open } = props;
  useEffect(() => {
    const toggle = (event: globalThis.KeyboardEvent) => {
      // Only the advertised modifier: Ctrl+K on Apple is kill-line in text fields.
      if (
        event.key.toLowerCase() !== "k" ||
        !(isApple ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      ) {
        return;
      }
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [onOpenChange, open]);

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open} title="Search">
      <CommandPaletteBody
        navItems={props.navItems}
        onClose={() => onOpenChange(false)}
      />
    </CommandDialog>
  );
}

/** Mounted only while open, so the search query runs only then. */
function CommandPaletteBody(props: {
  navItems: DashboardHeaderNavItem[];
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim());
  const feed = useConversationsData(search);
  const navigate = useNavigate();
  const list = useRef<HTMLDivElement>(null);
  // Hide conversation rows until they match the typed text, so stale or
  // placeholder rows never take Enter from a matching page.
  const conversationsCurrent =
    query.trim() === search && !feed.isPlaceholderData;
  const items = useMemo(
    () =>
      paletteItems({
        conversations: conversationsCurrent
          ? buildConversations(feed.data?.conversations ?? [])
          : [],
        navItems: props.navItems,
        query: query.trim(),
        search,
      }),
    [
      conversationsCurrent,
      feed.data?.conversations,
      props.navItems,
      query,
      search,
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
  const searching = query.trim() !== search || feed.isFetching;

  return (
    // Rows are already filtered: pages here, conversations on the server.
    <Command loop shouldFilter={false} vimBindings={false}>
      <CommandInput
        aria-label="Search conversations and pages"
        onValueChange={setQuery}
        placeholder="Search conversations or jump to…"
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
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
 * Build palette rows: recent or matching conversations, then pages. Pages
 * filter on the typed text at once; conversations wait for the server search.
 */
function paletteItems(input: {
  conversations: Conversation[];
  navItems: DashboardHeaderNavItem[];
  query: string;
  search: string;
}): PaletteItem[] {
  const conversations = input.conversations
    .slice(0, input.search ? RESULT_LIMIT : RECENT_LIMIT)
    .map(
      (conversation): PaletteItem => ({
        group: input.search ? "Conversations" : "Recent",
        icon:
          conversation.visibility === "private" ? LockKeyhole : MessageSquare,
        id: `conversation-${conversation.id}`,
        label: conversationDisplayTitle(conversation),
        meta: conversation.archivedAt
          ? "Archived"
          : formatCompactAge(conversation.lastSeenAt),
        to: conversationPath(conversation.id),
      }),
    );
  const needle = input.query.toLowerCase();
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
  ]
    .filter((page) => page.label.toLowerCase().includes(needle))
    .map(
      (page): PaletteItem => ({
        group: "Go to",
        icon: page.icon,
        id: `page-${page.key}`,
        label: page.label,
        to: page.to,
      }),
    );
  return [...conversations, ...pages];
}
