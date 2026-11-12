import {
  conversationFindSchema,
  type ConversationFind,
} from "@sentry/junior/api/schema";
import { useMutation } from "@tanstack/react-query";
import {
  LockKeyhole,
  MessageSquare,
  Sparkles,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { getDashboardAgentName } from "../agentName";
import { useConversationsData } from "../api";
import { formatCompactAge } from "../conversations/conversationAge";
import {
  FOCUS_REPLY_STATE,
  NEW_CONVERSATION_PATH,
  conversationPath,
} from "../conversations/conversationRoutes";
import { useCreateConversation } from "../conversations/queries";
import { useDebouncedValue } from "../debouncedValue";
import { buildConversations, conversationDisplayTitle } from "../format";
import { post } from "../http";
import { isPlatformShortcut, platformShortcut } from "../keyboard";
import type { Conversation } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { MatchedLabel } from "./MatchedLabel";
import { ShimmerText } from "./ShimmerText";
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

// Two letters still name a page or a title. A find needs more to go on.
const MIN_FIND_CHARS = 3;
const ASK_ITEM_ID = "ask-find";
const DIG_ITEM_ID = "ask-dig";

type PaletteItem = {
  /** Second line, such as why Junior picked the row. */
  detail?: string;
  disabled?: boolean;
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
} & ({ to: string } | { run: "dig" | "find" });

/** Where an ask for the typed text stands. */
type FindState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error" }
  | { status: "success"; matches: ConversationFind["matches"] };

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
  const [selected, setSelected] = useState("");
  const find = useMutation({
    mutationFn: (description: string) =>
      post(conversationFindSchema, "/api/conversations/find", {
        description,
      }),
    // The best fit takes the highlight, so Enter opens it.
    onSuccess: (result) =>
      setSelected(
        result.matches[0]
          ? `found-${result.matches[0].conversation.conversationId}`
          : DIG_ITEM_ID,
      ),
  });
  const dig = useCreateConversation();
  // An ask answers only the text it was asked for. Typed changes ask again.
  const asked = find.variables === query.trim();
  const findState = useMemo((): FindState => {
    if (!asked) return { status: "idle" };
    if (find.status === "success") {
      return { matches: find.data.matches, status: "success" };
    }
    return { status: find.status };
  }, [asked, find.data, find.status]);
  // Hide server rows until they match the typed text, so stale or
  // placeholder rows never show for the wrong query.
  const searchedCurrent =
    Boolean(search) && query.trim() === search && !searched.isPlaceholderData;
  const items = useMemo(
    () =>
      paletteItems({
        currentConversationId: props.currentConversationId,
        dig: dig.status,
        feed: buildConversations(feed.data?.conversations ?? []),
        find: findState,
        navItems: props.navItems,
        query: query.trim(),
        searched: searchedCurrent
          ? buildConversations(searched.data?.conversations ?? [])
          : [],
      }),
    [
      dig.status,
      feed.data?.conversations,
      findState,
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
  const select = (item: PaletteItem) => {
    if ("to" in item) {
      navigate(item.to, { state: item.state });
      props.onClose();
      return;
    }
    const description = query.trim();
    if (item.run === "find") {
      find.mutate(description);
      return;
    }
    // Hand the description to a full agent run, which can also search
    // messages and connected sources.
    dig.mutate(
      { idempotencyKey: crypto.randomUUID(), message: digMessage(description) },
      {
        onSuccess: (accepted) => {
          navigate(conversationPath(accepted.conversationId), {
            state: FOCUS_REPLY_STATE,
          });
          props.onClose();
        },
      },
    );
  };

  return (
    // Rows are already filtered and ranked in `paletteItems`.
    <Command
      loop
      onValueChange={setSelected}
      shouldFilter={false}
      value={selected}
      vimBindings={false}
    >
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
                  disabled={item.disabled}
                  key={item.id}
                  onSelect={() => select(item)}
                  value={item.id}
                >
                  <Icon aria-hidden="true" />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate">
                      <ShimmerText active={item.disabled}>
                        <MatchedLabel
                          label={item.label}
                          matches={item.matches}
                        />
                      </ShimmerText>
                    </span>
                    {item.detail ? (
                      <span className="truncate text-xs text-dashboard-text-faint">
                        {item.detail}
                      </span>
                    ) : null}
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
 * Build palette rows. With no typed text: the most recently active
 * conversations, then pages. With typed text: feed conversations and pages
 * ranked by match, the group with the best match first, then server matches
 * outside the feed. The open conversation is never a row.
 */
function paletteItems(input: {
  currentConversationId?: string;
  dig: "error" | "idle" | "pending" | "success";
  feed: Conversation[];
  find: FindState;
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
      const match = quickOpenMatch(page.label, input.query);
      return {
        ...pageItem(page),
        matches: match?.indices,
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
  const matched = pagesFirst
    ? [...matchedPages, ...conversations]
    : [...conversations, ...matchedPages];
  const ask = askItems(input);
  // With no title match the reader is likely describing, not naming, so the
  // ask comes first and Enter runs it. Once asked, its answer stays on top.
  return matched.length && input.find.status === "idle"
    ? [...matched, ...more, ...ask]
    : [...ask, ...matched, ...more];
}

/**
 * Rows that ask Junior to find what the typed text describes: the ask, its
 * wait, the Conversations it found with why each fits, and a way to keep
 * looking in a new Conversation.
 */
function askItems(input: {
  currentConversationId?: string;
  dig: "error" | "idle" | "pending" | "success";
  find: FindState;
  query: string;
}): PaletteItem[] {
  if (input.query.length < MIN_FIND_CHARS) return [];
  const agentName = getDashboardAgentName();
  const group = `Ask ${agentName}`;
  const base = { group, icon: Sparkles, score: 0 };
  const dig: PaletteItem = {
    ...base,
    detail:
      input.dig === "error"
        ? "The conversation did not start. Try again."
        : `${agentName} can also search messages and connected tools`,
    // Success navigates away, so the row waits until the palette closes.
    disabled: input.dig === "pending" || input.dig === "success",
    id: DIG_ITEM_ID,
    label:
      input.dig === "pending" || input.dig === "success"
        ? "Starting a conversation…"
        : "Keep looking in a new conversation",
    run: "dig",
  };
  switch (input.find.status) {
    case "idle":
      return [
        {
          ...base,
          detail: "Describe it in your own words",
          id: ASK_ITEM_ID,
          label: `Find “${input.query}”`,
          run: "find",
        },
      ];
    case "pending":
      return [
        {
          ...base,
          disabled: true,
          id: ASK_ITEM_ID,
          label: "Looking through your conversations…",
          run: "find",
        },
      ];
    case "error":
      return [
        {
          ...base,
          detail: "Something went wrong",
          id: ASK_ITEM_ID,
          label: "Try again",
          run: "find",
        },
        dig,
      ];
    case "success": {
      const found = buildConversations(
        input.find.matches.map((match) => match.conversation),
      );
      const reasons = new Map(
        input.find.matches.map((match) => [
          match.conversation.conversationId,
          match.reason,
        ]),
      );
      return [
        ...found
          .filter(
            (conversation) => conversation.id !== input.currentConversationId,
          )
          .map((conversation) => ({
            ...conversationItem(conversation, group),
            detail: reasons.get(conversation.id),
            id: `found-${conversation.id}`,
          })),
        found.length
          ? dig
          : {
              ...dig,
              label: "Nothing fits. Keep looking in a new conversation",
            },
      ];
    }
  }
}

/** The first message of a Conversation that keeps looking. */
function digMessage(description: string): string {
  return [
    "Help me find something I can only describe:",
    "",
    `> ${description.replace(/\n+/g, " ")}`,
    "",
    "Search my past conversations and their messages, and any connected source that fits. Link the best matches and say in one line why each fits.",
  ].join("\n");
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
