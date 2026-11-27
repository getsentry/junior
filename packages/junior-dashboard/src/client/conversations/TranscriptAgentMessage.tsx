import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useContext } from "react";
import { Link } from "react-router";

import { ClampedDisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import {
  agentMessageConversationTitle,
  receivedAgentMessage,
  type AgentMessage,
  type AgentMessageDelivery,
} from "./agentMessage";
import { usePrefetchConversation } from "./conversationPrefetch";
import { conversationPath } from "./conversationRoutes";
import { FeedThreads } from "./feedThreads";
import { TranscriptRailEvent } from "./TranscriptRailEvent";
import { RedactedMarker } from "./TranscriptRedacted";
import { TranscriptTimestamp } from "./TranscriptTimestamp";

const deliveryLabels: Record<AgentMessageDelivery, string> = {
  delivered: "Delivered",
  noted: "Saved as a note",
  queued: "Queued",
  refused: "Refused",
  sending: "Sending",
};

/**
 * Show one message between two agents as a compact row: which way it went,
 * the other Conversation linked by its title, what happened to a sent one,
 * and the text, clamped when long. A sent and a received message share it,
 * so they read as a pair.
 */
export function TranscriptAgentMessage(props: {
  conversation: ConversationTranscript;
  message: AgentMessage;
  timestamp?: number | undefined;
}) {
  const { message } = props;
  const sent = message.direction === "sent";
  const title = useAgentMessageTitle(props.conversation, message);
  const label = `${sent ? "Message to" : "Message from"} ${title}`;
  return (
    <TranscriptRailEvent
      icon={sent ? ArrowUpRight : ArrowDownLeft}
      kind="agent_message"
    >
      <div aria-label={label} className="grid min-w-0 gap-0.5" role="group">
        <div className="flex min-h-6 min-w-0 items-center gap-1.5 font-sans text-xs text-dashboard-text-muted">
          <span className="shrink-0">{sent ? "To" : "From"}</span>
          {message.conversationId ? (
            <ConversationLink id={message.conversationId} title={title} />
          ) : (
            <span className="min-w-0 truncate font-medium text-dashboard-text">
              {title}
            </span>
          )}
          {message.delivery ? (
            <>
              <span aria-hidden="true">·</span>
              <span
                className={cn(
                  "shrink-0",
                  message.delivery === "refused" && "text-rose-300",
                )}
              >
                {deliveryLabels[message.delivery]}
              </span>
            </>
          ) : null}
          <span className="ml-auto shrink-0 pl-2 tabular-nums text-dashboard-text-faint">
            <TranscriptTimestamp value={props.timestamp} />
          </span>
        </div>
        {message.text === undefined ? (
          <RedactedMarker />
        ) : (
          <ClampedDisplayText
            className="text-sm leading-6 text-dashboard-text"
            label={label}
            lines={4}
            text={message.text}
          />
        )}
      </div>
    </TranscriptRailEvent>
  );
}

/** Show an Event message that another agent sent as its message row. */
export function TranscriptReceivedAgentMessage(props: {
  conversation: ConversationTranscript;
  message: TranscriptViewMessage;
}) {
  const message = receivedAgentMessage(props.message);
  return message ? (
    <TranscriptAgentMessage
      conversation={props.conversation}
      message={message}
      timestamp={props.message.timestamp}
    />
  ) : null;
}

function ConversationLink(props: { id: string; title: string }) {
  const prefetch = usePrefetchConversation(props.id);
  return (
    <Link
      {...prefetch}
      className="min-w-0 truncate font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
      to={conversationPath(props.id)}
    >
      {props.title}
    </Link>
  );
}

/**
 * The other Conversation's own title when the feed lists it, as the sidebar
 * does. Otherwise the name that this transcript recorded for it.
 */
function useAgentMessageTitle(
  conversation: ConversationTranscript,
  message: AgentMessage,
): string {
  const feedThreads = useContext(FeedThreads);
  const id = message.conversationId;
  return (
    (id ? feedThreads.get(id)?.displayTitle : undefined) ??
    agentMessageConversationTitle(conversation, message)
  );
}
