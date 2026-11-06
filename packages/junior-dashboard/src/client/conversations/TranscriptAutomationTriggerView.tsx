import { ArrowRight, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { buttonVariants } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Link } from "react-router";
import { ObjectIcon } from "../components/ObjectIcon";
import { automationPath, formatRelativeTime } from "../format";
import { messageRawText } from "./transcriptRenderModel";
import { HighlightText } from "./transcriptSearch";
import { RedactedMarker } from "./TranscriptRedacted";
import { cn } from "../styles";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";

type SourceTask = NonNullable<ConversationDetailReport["sourceTask"]>;

/** True when a message is the trigger input of an Automation run. */
export function isAutomationTriggerMessage(
  conversation: ConversationTranscript,
  message: TranscriptViewMessage,
): boolean {
  const triggerMessageId = conversation.sourceTask?.triggerMessageId;
  return Boolean(
    triggerMessageId &&
    message.role === "user" &&
    message.messageId === triggerMessageId,
  );
}

function runsAsLabel(sourceTask: SourceTask): string | undefined {
  if (sourceTask.credentialMode === "system") return "Runs as system";
  if (sourceTask.credentialMode === "creator" && sourceTask.credentialUser) {
    return `Runs as ${sourceTask.credentialUser}`;
  }
  return undefined;
}

/**
 * Show which Automation started this run, what triggered it, and whose
 * credentials it used. The run input is not from a person, so it stays
 * collapsed behind "Show prompt".
 */
export function TranscriptAutomationTriggerView(props: {
  message: TranscriptViewMessage;
  sourceTask: SourceTask;
}) {
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  const [open, setOpen] = useState(false);
  const automationId = props.sourceTask.id?.trim();
  const name = props.sourceTask.title?.trim() || "Automation";
  const details = [
    props.sourceTask.triggerLabel,
    props.message.timestamp
      ? formatRelativeTime(new Date(props.message.timestamp).toISOString())
      : undefined,
    runsAsLabel(props.sourceTask),
  ].filter(Boolean);

  return (
    <section
      aria-label={name}
      className="grid w-full min-w-0 max-w-[37.5rem] gap-2 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ObjectIcon objectType="automation" size={16} decorative />
        <span className="min-w-0 flex-1 truncate font-sans text-sm font-semibold text-dashboard-text">
          <HighlightText text={name} />
        </span>
        {automationId ? (
          <Link
            className={cn(buttonVariants(), "h-8 shrink-0 text-xs")}
            to={automationPath(automationId)}
          >
            Open automation
            <ArrowRight aria-hidden="true" size={14} />
          </Link>
        ) : null}
      </div>
      {details.length > 0 ? (
        <p className="m-0 min-w-0 break-words text-xs leading-relaxed text-dashboard-text-muted">
          {details.join(" · ")}
        </p>
      ) : null}
      {text ? (
        <Collapsible className="min-w-0" onOpenChange={setOpen} open={open}>
          <CollapsibleTrigger className="group -mx-1 inline-flex cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent px-1 py-0.5 font-sans text-xs font-medium text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus">
            <ChevronRight
              aria-hidden="true"
              className="size-3 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
              strokeWidth={2.2}
            />
            {open ? "Hide prompt" : "Show prompt"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dashboard-border-subtle bg-dashboard-bg px-3 py-2 font-mono text-xs leading-relaxed text-dashboard-text-muted">
              <HighlightText text={text} />
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : redacted ? (
        <RedactedMarker />
      ) : null}
    </section>
  );
}
