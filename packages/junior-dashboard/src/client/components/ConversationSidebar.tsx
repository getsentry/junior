import { Search } from "lucide-react";
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
import { statusBorderClass } from "./statusStyles";

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
    <aside className="grid min-h-0 min-w-0 grid-rows-[auto_auto_1fr] border-r border-white/10 bg-[#050505]">
      <div className="border-b border-white/10 px-4 py-4">
        <h2 className="m-0 text-lg font-bold leading-tight text-white">
          Your conversations
        </h2>
        <div className="mt-1 text-[0.8rem] leading-relaxed text-[#888]">
          {props.loading
            ? "Loading conversations…"
            : `${props.conversations.length} conversation${props.conversations.length === 1 ? "" : "s"}`}
        </div>
      </div>
      <div className="border-b border-white/10 p-3">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#666]"
            size={14}
          />
          <input
            aria-label="Search your conversations"
            className="h-9 w-full rounded-md border border-white/10 bg-white/[0.04] pl-9 pr-3 text-[0.84rem] text-white outline-none placeholder:text-[#666] focus:border-[#beaaff]/50 focus:ring-1 focus:ring-[#beaaff]/20"
            onChange={(event) => props.onQueryChange(event.currentTarget.value)}
            placeholder="Search conversations…"
            type="search"
            value={props.query}
          />
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {props.error ? (
          <div className="p-3">
            <EmptyTelemetry>{props.error}</EmptyTelemetry>
          </div>
        ) : !props.loading && props.conversations.length === 0 ? (
          <div className="p-3">
            <EmptyTelemetry>No conversations match this view.</EmptyTelemetry>
          </div>
        ) : (
          <nav aria-label="Your conversations">
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
        "block min-w-0 border-b border-l-4 border-b-white/10 px-4 py-3 text-inherit no-underline transition-colors hover:bg-white/[0.06]",
        statusBorderClass(status),
        props.selected && "bg-[#151515]",
      )}
      to={conversationPath(props.conversation.id)}
    >
      <div className="truncate text-[0.92rem] font-semibold leading-tight text-white">
        {conversationDisplayTitle(props.conversation)}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[0.76rem] leading-tight text-[#888]">
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
