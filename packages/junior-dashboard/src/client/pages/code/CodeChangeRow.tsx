import type { CodeChangeSummaryReport } from "@sentry/junior/api/schema";

import { StatusChip } from "../../components/StatusChip";

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
            <a
              className="text-inherit no-underline hover:text-cyan-100"
              href={change.url}
              rel="noreferrer"
              target="_blank"
            >
              {title}
            </a>
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
