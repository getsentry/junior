import { useNavigate } from "react-router";

import {
  conversationPath,
  formatTime,
  visualStatusForConversation,
} from "../format";
import { cn } from "../styles";
import type { Conversation, VisualStatus } from "../types";
import { ConversationRowStats } from "./ConversationRowStats";
import { ConversationSummary } from "./ConversationSummary";
import { EmptyTelemetry } from "./EmptyTelemetry";

/** Render the full conversation table used by the conversations page. */
export function ConversationList(props: {
  conversations: Conversation[];
  emptyLabel?: string;
  selectedId?: string;
  search?: string;
}) {
  if (props.conversations.length === 0) {
    return (
      <div className="grid gap-2 p-3">
        <EmptyTelemetry>
          {props.emptyLabel ?? "No conversations to show."}
        </EmptyTelemetry>
      </div>
    );
  }

  return (
    <div className="min-w-0" role="table">
      <div
        className="sticky top-0 z-[1] grid grid-cols-[minmax(13rem,1.7fr)_minmax(13rem,1fr)] items-center gap-3 border-b border-white/[0.06] bg-black/25 px-3 py-2.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-white/30 max-md:hidden"
        role="row"
      >
        <div>Conversation</div>
        <div className="justify-self-end">Stats</div>
      </div>
      {props.conversations.map((conversation) => (
        <ConversationTableRow
          conversation={conversation}
          key={conversation.id}
          search={props.search}
          selected={props.selectedId === conversation.id}
        />
      ))}
    </div>
  );
}

function ConversationTableRow(props: {
  conversation: Conversation;
  search?: string;
  selected?: boolean;
}) {
  const visualStatus = visualStatusForConversation(props.conversation);
  const navigate = useNavigate();
  const href = {
    pathname: conversationPath(props.conversation.id),
    search: props.search ?? "",
  };
  const openConversation = () => navigate(href);
  return (
    <div
      className={conversationRecordClass(visualStatus, props.selected)}
      onClick={openConversation}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openConversation();
        }
      }}
      role="link"
      tabIndex={0}
    >
      <ConversationSummary conversation={props.conversation} />
      <ConversationRowStats
        conversation={props.conversation}
        timeLabel={formatTime(props.conversation.lastSeenAt)}
      />
    </div>
  );
}

function conversationRecordClass(
  status: VisualStatus,
  selected: boolean | undefined,
): string {
  return cn(
    "group grid min-w-0 cursor-pointer grid-cols-[minmax(13rem,1.7fr)_minmax(13rem,1fr)] items-center gap-3 overflow-hidden border-b border-b-white/[0.055] px-3 py-3 text-left text-inherit no-underline transition-colors hover:bg-white/[0.035] max-md:grid-cols-1 max-md:px-4 max-md:py-4",
    status === "idle" && "saturate-50",
    selected && "bg-cyan-400/[0.045]",
  );
}
