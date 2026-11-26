import { memo, useMemo } from "react";
import { TriangleAlert, Wrench } from "lucide-react";

import { HighlightedCode } from "../code";
import { formatPayloadSize, stringifyPartValue } from "../format";
import type {
  ConversationTranscript,
  TranscriptViewToolCallPart,
} from "../types";
import { ShimmerText } from "../components/ShimmerText";
import { InboxItemAskRow } from "../inbox/InboxItemChangeRow";
import { inboxItemIdFromToolCall } from "../inbox/inboxItemFormat";
import { cn } from "../styles";
import { sentAgentMessage } from "./agentMessage";
import { ToolFrame } from "./ToolFrame";
import { TranscriptAgentMessage } from "./TranscriptAgentMessage";
import { toolCallPreview } from "./toolCallPreview";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";
import { formatElapsedDuration, formatMessageTimestamp } from "../time";

type ToolViewProps = {
  conversation: ConversationTranscript;
  part: TranscriptViewToolCallPart;
  timestamp?: number | undefined;
};

/**
 * Render one tool invocation as it advances from running to a terminal
 * result. A message to another agent shows as its message row.
 */
export const TranscriptToolView = memo(
  function TranscriptToolView(props: ToolViewProps) {
    const sent = sentAgentMessage(props.part);
    return sent ? (
      <TranscriptAgentMessage
        conversation={props.conversation}
        message={sent}
        timestamp={props.timestamp}
      />
    ) : (
      <ToolCallView {...props} />
    );
  },
  // A message row reads titles from the rest of the Conversation. Events
  // store them before the message is sent, so newer events do not change
  // them. The agent tree takes the current titles, such as after a rename.
  (previous, next) =>
    previous.part === next.part &&
    previous.timestamp === next.timestamp &&
    previous.conversation.conversationId === next.conversation.conversationId &&
    previous.conversation.agentTree === next.conversation.agentTree,
);

function ToolCallView(props: ToolViewProps) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  const duration = formatElapsedDuration(
    props.timestamp,
    props.part.resultTimestamp,
  );
  const hasDetails =
    props.part.input !== undefined || props.part.output !== undefined;
  const responseSize = useMemo(
    () => formatPayloadSize(props.part.output),
    [props.part.output],
  );
  const executionMeta = [duration, responseSize].filter(isString).join(" · ");
  const meta = [executionMeta, timestamp].filter(isString);
  const mobileSummary = executionMeta;
  const preview = toolCallPreview(props.part.name, props.part.input);
  const signature = (
    <ToolSignature
      name={props.part.name}
      preview={preview}
      status={props.part.status}
    />
  );
  const frame = (
    <ToolFrame
      expandable={hasDetails}
      icon={props.part.status === "error" ? TriangleAlert : Wrench}
      iconClassName={
        props.part.status === "error"
          ? "text-rose-300"
          : "text-dashboard-text-faint"
      }
      meta={meta}
      mobileSummaryMeta={mobileSummary}
      signature={signature}
    >
      {props.part.input !== undefined ? (
        <ToolPayload label="arguments" value={props.part.input} />
      ) : null}
      {props.part.output !== undefined ? (
        <ToolPayload label="result" value={props.part.output} />
      ) : null}
    </ToolFrame>
  );

  // A question that Junior asked shows as its one-line record. The tool call
  // shows only when the viewer cannot read the item.
  const inboxItemId = inboxItemIdFromToolCall(props.part);
  if (inboxItemId) {
    return (
      <InboxItemAskRow
        conversationId={props.conversation.conversationId}
        fallback={frame}
        itemId={inboxItemId}
      />
    );
  }
  return <div className="min-w-0">{frame}</div>;
}

function ToolSignature(props: {
  name: string;
  preview: string | null;
  status: TranscriptViewToolCallPart["status"];
}) {
  const { active: searchActive } = useTranscriptSearch();
  const running = props.status === "running";
  const failed = props.status === "error";
  const shimmering = running && !searchActive;
  const statusLabel = running
    ? `${props.name} (running)`
    : failed
      ? `${props.name} (failed)`
      : undefined;

  return (
    <>
      <ShimmerText
        active={shimmering}
        aria-label={statusLabel}
        as="strong"
        className={cn(
          "shrink-0 font-bold",
          failed ? "!text-rose-300" : !shimmering && "text-dashboard-text",
        )}
      >
        <HighlightText text={props.name} />
      </ShimmerText>
      {props.preview && !searchActive ? (
        <code className="min-w-0 truncate font-[inherit] text-dashboard-text-muted group-aria-expanded/trace-collapsible-trigger:hidden">
          (<HighlightText text={props.preview} />)
        </code>
      ) : null}
    </>
  );
}

function ToolPayload(props: { label: string; value: unknown }) {
  const code = useMemo(() => stringifyPartValue(props.value), [props.value]);
  return (
    <div className="min-w-0 max-w-full overflow-hidden border-dashboard-border-subtle px-3 py-2.5 [&+&]:border-t">
      <div className="pb-1.5 font-sans text-xs font-medium leading-none text-dashboard-text-muted">
        {props.label}
      </div>
      <HighlightedCode code={code} language="json" />
    </div>
  );
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
