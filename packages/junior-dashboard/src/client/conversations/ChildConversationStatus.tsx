import { CircleAlert, CircleCheck, CircleStop, CircleX } from "lucide-react";

import { StatusChip, type StatusChipTone } from "../components/StatusChip";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import type { ConversationStatus } from "../types";

const labels: Record<ConversationStatus, string> = {
  active: "Running",
  failed: "Failed",
  idle: "Idle",
  needs_input: "Needs input",
  stopped: "Stopped",
};

const tones: Record<ConversationStatus, StatusChipTone> = {
  active: "info",
  failed: "danger",
  idle: "neutral",
  needs_input: "warning",
  stopped: "neutral",
};

/** Mark a Thread or Task status with one icon and an audible label. */
export function ChildConversationStatusIcon(props: {
  className?: string;
  status: ConversationStatus;
}) {
  const label = labels[props.status];
  const className = cn("size-3.5 shrink-0", props.className);
  if (props.status === "active") {
    return (
      <Spinner
        aria-label={label}
        className={cn(className, "text-dashboard-text-muted")}
      />
    );
  }
  const Icon =
    props.status === "needs_input"
      ? CircleAlert
      : props.status === "failed"
        ? CircleX
        : props.status === "stopped"
          ? CircleStop
          : CircleCheck;
  return (
    <Icon
      aria-label={label}
      className={cn(
        className,
        props.status === "needs_input" && "text-amber-400",
        props.status === "failed" && "text-rose-400",
        (props.status === "idle" || props.status === "stopped") &&
          "text-dashboard-text-faint",
      )}
      role="img"
    />
  );
}

/** Show the status of a Thread or Task page beside its title. */
export function ChildConversationStatusPill(props: {
  status: ConversationStatus;
}) {
  return (
    <StatusChip
      className={cn(
        "shrink-0",
        props.status === "active" && "animate-pulse motion-reduce:animate-none",
      )}
      size="compact"
      tone={tones[props.status]}
    >
      {labels[props.status]}
    </StatusChip>
  );
}
