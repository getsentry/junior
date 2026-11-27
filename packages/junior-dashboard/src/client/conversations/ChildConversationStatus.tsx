import { CircleAlert, CircleCheck } from "lucide-react";

import { StatusChip, type StatusChipTone } from "../components/StatusChip";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import type {
  Conversation,
  ConversationStatus,
  TranscriptViewSubagentPart,
} from "../types";
import {
  childAgentStatusLabel,
  useConversationChildAgents,
} from "./ConversationChildAgents";

/**
 * The status of a Thread or Task: its own work, or how its last Turn ended
 * when that was blocked or failed, which its own status reads as done.
 */
type ChildStatus = ConversationStatus | "blocked" | "failed";

const labels: Record<ChildStatus, string> = {
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  needs_input: "Needs input",
  working: "Working",
};

const tones: Record<ChildStatus, StatusChipTone> = {
  blocked: "warning",
  done: "neutral",
  failed: "danger",
  needs_input: "warning",
  working: "info",
};

// A stop is not a result, so a stopped child is done. A start with no end
// yet may be stale, so it gives no status.
const subagentStatuses: Partial<
  Record<TranscriptViewSubagentPart["status"], ChildStatus>
> = {
  aborted: "done",
  blocked: "blocked",
  completed: "done",
  error: "failed",
};

/** Read the result that the parent recorded when a child's work ended. */
export function subagentChildStatus(
  status: TranscriptViewSubagentPart["status"],
): ChildStatus | undefined {
  return subagentStatuses[status];
}

/** Mark a Thread or Task status with one icon and an audible label. */
export function ChildConversationStatusIcon(props: {
  className?: string;
  status: ConversationStatus;
}) {
  const label = labels[props.status];
  const className = cn("size-3.5 shrink-0", props.className);
  if (props.status === "working") {
    return (
      <Spinner
        aria-label={label}
        className={cn(className, "text-dashboard-text-muted")}
      />
    );
  }
  const Icon = props.status === "needs_input" ? CircleAlert : CircleCheck;
  return (
    <Icon
      aria-label={label}
      className={cn(
        className,
        props.status === "needs_input"
          ? "text-amber-400"
          : "text-dashboard-text-faint",
      )}
      role="img"
    />
  );
}

/** Show the status of a Thread or Task beside its title. */
export function ChildConversationStatusPill(props: { status: ChildStatus }) {
  return (
    <StatusChip
      className={cn(
        "shrink-0",
        props.status === "working" &&
          "animate-pulse motion-reduce:animate-none",
      )}
      size="compact"
      tone={tones[props.status]}
    >
      {labels[props.status]}
    </StatusChip>
  );
}

/**
 * Read the status of a Thread or Task. Once its work is done, its parent's
 * report of its last result says when it blocked or failed. While that
 * report loads, a done child has no status yet, so a page and a card never
 * show Done first. A failed read or a child the report leaves out is done.
 */
export function useChildStatus(
  conversation:
    | Pick<Conversation, "id" | "parentConversationId" | "status">
    | undefined,
): ChildStatus | undefined {
  const parentId = conversation?.parentConversationId;
  const done = conversation?.status === "done";
  const agents = useConversationChildAgents(
    parentId ?? "",
    parentId !== undefined && done,
  );
  if (!conversation || !done || parentId === undefined) {
    return conversation?.status;
  }
  if (agents.isPending) return undefined;
  const agent = agents.data?.agents.find(
    (candidate) => candidate.conversationId === conversation.id,
  );
  const result = agent ? childAgentStatusLabel(agent) : undefined;
  return result === "blocked" || result === "failed" ? result : "done";
}

/** Show the status of a Thread or Task page. */
export function ChildPageStatusPill(props: {
  conversation: Pick<Conversation, "id" | "parentConversationId" | "status">;
}) {
  const status = useChildStatus(props.conversation);
  return status ? <ChildConversationStatusPill status={status} /> : null;
}
