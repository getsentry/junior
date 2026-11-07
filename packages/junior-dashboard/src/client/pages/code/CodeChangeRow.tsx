import type { CodeChangeSummaryReport } from "@sentry/junior/api/schema";

import { StatusChip } from "../../components/StatusChip";
import { OutboundLink } from "../../components/OutboundLink";

function stateTone(state: CodeChangeSummaryReport["state"]) {
  if (state === "merged") return "success" as const;
  if (state === "open") return "info" as const;
  return "neutral" as const;
}

/** Show one code change with its title, repository reference, and state. */
export function CodeChangeRow(props: { change: CodeChangeSummaryReport }) {
  const change = props.change;
  const title = change.title ?? `${change.repository} #${change.number}`;
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 border-b border-dashboard-border-subtle px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-display text-sm text-dashboard-text">
          {change.url ? (
            // Truncate the title, not the link, so the outbound icon stays.
            <OutboundLink
              className="inline-flex max-w-full items-center text-inherit no-underline hover:text-dashboard-accent-text"
              href={change.url}
            >
              <span className="truncate">{title}</span>
            </OutboundLink>
          ) : (
            title
          )}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-dashboard-text-muted">
          {change.repository} #{change.number}
        </div>
      </div>
      <StatusChip size="compact" tone={stateTone(change.state)}>
        {change.state}
      </StatusChip>
    </div>
  );
}
