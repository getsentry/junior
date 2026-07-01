import { useNavigate } from "react-router";

import {
  conversationPath,
  formatRelativeTime,
  visualStatusForConversation,
} from "../format";
import { cn } from "../styles";
import type { Conversation, VisualStatus } from "../types";
import { ConversationRowStats } from "./ConversationRowStats";
import { ConversationSummary } from "./ConversationSummary";
import { EmptyTelemetry } from "./EmptyTelemetry";

/** Render the compact latest-conversation stack on the command center. */
export function ConversationStack(props: {
  conversations: Conversation[];
  emptyLabel?: string;
}) {
  if (props.conversations.length === 0) {
    return (
      <div className="p-3">
        <EmptyTelemetry>
          {props.emptyLabel ?? "No conversation telemetry yet."}
        </EmptyTelemetry>
      </div>
    );
  }

  return (
    <div className="grid">
      {props.conversations.map((conversation) => (
        <ConversationStackRow
          conversation={conversation}
          key={conversation.id}
        />
      ))}
    </div>
  );
}

function ConversationStackRow(props: { conversation: Conversation }) {
  const visualStatus = visualStatusForConversation(props.conversation);
  const navigate = useNavigate();
  const href = conversationPath(props.conversation.id);
  return (
    <div
      className={conversationStackRowClass(visualStatus)}
      onClick={() => navigate(href)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate(href);
        }
      }}
      role="link"
      tabIndex={0}
    >
      <ConversationSummary conversation={props.conversation} />
      <ConversationRowStats
        conversation={props.conversation}
        timeLabel={formatRelativeTime(props.conversation.lastSeenAt)}
      />
    </div>
  );
}

function conversationStackRowClass(status: VisualStatus): string {
  return cn(
    "group relative grid min-h-16 cursor-pointer grid-cols-[minmax(0,1fr)_minmax(12rem,max-content)] items-center gap-3 overflow-hidden border-b border-l-4 border-b-white/10 bg-[#050505] px-4 py-3 text-inherit no-underline transition-colors last:border-b-0 hover:bg-[rgba(190,170,255,0.07)] max-md:grid-cols-1",
    status === "active" && "border-l-emerald-400",
    status === "hung" && "border-l-amber-400",
    status === "failed" && "border-l-rose-400",
    status === "idle" && "border-l-[#beaaff]/60",
    status === "idle" && "saturate-50",
  );
}
