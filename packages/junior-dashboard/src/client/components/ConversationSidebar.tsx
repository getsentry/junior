import { MessageSquareText, Search } from "lucide-react";
import { Link } from "react-router";

import {
  conversationDisplayTitle,
  conversationPath,
  formatRelativeTime,
  slackLocationLabel,
  visualStatusForConversation,
} from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { EmptyTelemetry } from "./EmptyTelemetry";

/** Render the compact personal conversation picker used by the home workspace. */
export function ConversationSidebar(props: {
  conversations: Conversation[];
  error?: string;
  loading: boolean;
  query: string;
  selectedId?: string;
  onQueryChange(value: string): void;
}) {
  return (
    <aside className="grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-white/[0.07] bg-white/[0.02]">
      <div className="px-5 pb-3 pt-5">
        <div className="mb-2 flex items-center gap-2 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
          <MessageSquareText aria-hidden="true" size={13} />
          Your trail
        </div>
        <div className="flex items-end justify-between gap-3">
          <h2 className="m-0 font-display text-xl font-medium leading-tight text-white">
            Conversations
          </h2>
          <div className="rounded border border-white/[0.08] bg-black/20 px-2.5 py-1 font-mono text-[0.62rem] text-white/40">
            {props.loading ? "…" : props.conversations.length}
          </div>
        </div>
      </div>
      <div className="px-3 pb-3">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/25"
            size={14}
          />
          <input
            aria-label="Search your conversations"
            className="h-10 w-full rounded-lg border border-white/[0.08] bg-black/20 pl-9 pr-3 font-mono text-[0.74rem] text-white/80 outline-none transition-colors placeholder:text-white/20 hover:border-white/15 focus:border-cyan-300/35 focus:ring-2 focus:ring-cyan-300/10"
            onChange={(event) => props.onQueryChange(event.currentTarget.value)}
            placeholder="Search conversations…"
            type="search"
            value={props.query}
          />
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
        {props.error ? (
          <div className="p-3">
            <EmptyTelemetry>{props.error}</EmptyTelemetry>
          </div>
        ) : !props.loading && props.conversations.length === 0 ? (
          <div className="p-3">
            <EmptyTelemetry>No conversations match this view.</EmptyTelemetry>
          </div>
        ) : (
          <nav aria-label="Your conversations" className="grid gap-1">
            {props.conversations.map((conversation) => (
              <ConversationSidebarRow
                conversation={conversation}
                key={conversation.id}
                selected={conversation.id === props.selectedId}
              />
            ))}
          </nav>
        )}
      </div>
    </aside>
  );
}

function ConversationSidebarRow(props: {
  conversation: Conversation;
  selected: boolean;
}) {
  const status = visualStatusForConversation(props.conversation);
  const location = slackLocationLabel(props.conversation, {
    includeId: false,
  });
  return (
    <Link
      aria-current={props.selected ? "page" : undefined}
      className={cn(
        "relative block min-w-0 rounded-lg border border-transparent px-3 py-3 text-inherit no-underline transition-all hover:border-white/[0.07] hover:bg-white/[0.035]",
        props.selected && "border-cyan-300/20 bg-cyan-300/[0.07]",
      )}
      to={conversationPath(props.conversation.id)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status === "active" &&
              "bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.55)]",
            status === "failed" && "bg-rose-300",
            status === "idle" && "bg-white/25",
          )}
        />
        <div className="truncate font-display text-[0.92rem] font-medium leading-tight text-white/90">
          {conversationDisplayTitle(props.conversation)}
        </div>
      </div>
      <div className="ml-3.5 mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[0.62rem] leading-tight text-white/30">
        <span className="shrink-0">
          {formatRelativeTime(props.conversation.lastSeenAt)}
        </span>
        {location ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{location}</span>
          </>
        ) : null}
      </div>
    </Link>
  );
}
