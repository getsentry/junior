import {
  LockKeyhole,
  MessageSquare,
  Search,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";

import { useConversationsData } from "../api";
import { formatCompactAge } from "../conversations/conversationAge";
import {
  NEW_CONVERSATION_PATH,
  conversationPath,
} from "../conversations/conversationRoutes";
import { useDebouncedValue } from "../debouncedValue";
import { buildConversations, conversationDisplayTitle } from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { Dialog, DialogContent } from "./ui/dialog";

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
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
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
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-label="Search"
        className="max-w-xl gap-0 overflow-hidden p-0 sm:top-[15vh] sm:translate-y-0"
      >
        <CommandPaletteBody
          navItems={props.navItems}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while open, so the search query runs only then. */
function CommandPaletteBody(props: {
  navItems: DashboardHeaderNavItem[];
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const search = useDebouncedValue(query.trim());
  const feed = useConversationsData(search);
  const navigate = useNavigate();
  const listId = useId();
  const items = useMemo(
    () =>
      paletteItems({
        conversations: buildConversations(feed.data?.conversations ?? []),
        navItems: props.navItems,
        query: query.trim(),
        search,
      }),
    [feed.data?.conversations, props.navItems, query, search],
  );
  const active = items[Math.min(activeIndex, items.length - 1)];

  useEffect(() => {
    setActiveIndex(0);
  }, [query, search]);
  const activeOptionId = active ? `${listId}-${active.id}` : undefined;
  useEffect(() => {
    if (!activeOptionId) return;
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        (index) =>
          (Math.min(index, items.length - 1) + step + items.length) %
          items.length,
      );
    } else if (event.key === "Enter" && active) {
      event.preventDefault();
      navigate(active.to);
      props.onClose();
    }
  };

  const groups = [...new Set(items.map((item) => item.group))].map(
    (group) => [group, items.filter((item) => item.group === group)] as const,
  );
  const searching = query.trim() !== search || feed.isFetching;

  return (
    <>
      <div className="flex items-center gap-3 border-b border-dashboard-border-subtle px-4">
        <Search
          aria-hidden="true"
          className="size-4 shrink-0 text-dashboard-text-muted"
        />
        <input
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-label="Search conversations and pages"
          autoComplete="off"
          className="h-12 min-w-0 flex-1 border-0 bg-transparent font-sans text-sm text-dashboard-text outline-none placeholder:text-dashboard-text-faint"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Search conversations or jump to…"
          role="combobox"
          spellCheck={false}
          value={query}
        />
        <kbd className="shrink-0 rounded border max-sm:hidden border-dashboard-border px-1.5 py-0.5 font-sans text-xs text-dashboard-text-faint">
          esc
        </kbd>
      </div>
      <div
        className="thin-scrollbar max-h-[min(24rem,60dvh)] overflow-y-auto overscroll-contain p-2"
        id={listId}
        role="listbox"
      >
        {items.length === 0 ? (
          <p className="m-0 px-3 py-6 text-center font-sans text-sm text-dashboard-text-muted">
            {searching ? "Searching…" : "No matches."}
          </p>
        ) : (
          groups.map(([group, groupItems]) => (
            <div aria-label={group} key={group} role="group">
              <div
                aria-hidden="true"
                className="px-3 pb-1 pt-2 font-sans text-xs font-medium text-dashboard-text-muted"
              >
                {group}
              </div>
              {groupItems.map((item) => {
                const Icon = item.icon;
                const selected = item === active;
                return (
                  <Link
                    aria-selected={selected}
                    className={cn(
                      "grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-3 py-2 font-sans text-sm text-dashboard-text no-underline",
                      selected && "bg-dashboard-fill-hover",
                    )}
                    id={`${listId}-${item.id}`}
                    key={item.id}
                    onClick={props.onClose}
                    onMouseMove={() => setActiveIndex(items.indexOf(item))}
                    role="option"
                    tabIndex={-1}
                    to={item.to}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-4 text-dashboard-text-muted"
                    />
                    <span className="min-w-0 truncate">{item.label}</span>
                    {item.meta ? (
                      <span className="text-xs tabular-nums text-dashboard-text-faint">
                        {item.meta}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))
        )}
      </div>
    </>
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
