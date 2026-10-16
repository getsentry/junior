import { Link } from "react-router";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { ObjectIcon } from "../components/ObjectIcon";
import { automationPath } from "../format";
import { cn, dashboardInlineLinkClass } from "../styles";

type SourceTask = NonNullable<ConversationDetailReport["sourceTask"]>;

/** Name the Automation that started a run, or its kind when it is hidden. */
export function automationRunLabel(sourceTask: SourceTask): string {
  const title = sourceTask.title?.trim();
  if (title) return `Automation: ${title}`;
  return sourceTask.kind === "scheduled"
    ? "Scheduled automation"
    : "Event automation";
}

/**
 * Link a run Conversation to the Automation that started it. Viewers who
 * cannot see the Automation get its kind without a link.
 */
export function ConversationAutomationLink(props: {
  className?: string;
  /** Hide the icon when the surrounding row already shows it. */
  hideIcon?: boolean;
  sourceTask: SourceTask;
}) {
  const automationId = props.sourceTask.id?.trim();
  const label = automationRunLabel(props.sourceTask);
  const content = (
    <>
      {props.hideIcon ? null : (
        <ObjectIcon objectType="automation" size={13} decorative />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  const className = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1.5",
    props.className,
  );
  return automationId ? (
    <Link
      className={cn(className, dashboardInlineLinkClass)}
      title={label}
      to={automationPath(automationId)}
    >
      {content}
    </Link>
  ) : (
    <span className={className}>{content}</span>
  );
}
