import type { CodeChangeSummaryReport } from "@sentry/junior/api/schema";

import { StatusChip } from "../../components/StatusChip";
import { OutboundLink } from "../../components/OutboundLink";
import { IdleText } from "../../conversations/codeChangeIdle";
import {
  type ListedObject,
  MessageObjectsProvider,
  useListedObjects,
} from "../../display-text/DisplayText";
import { listedDraft } from "../../listedCodeChange";

// Only an open change can be a draft, so only it waits for its live card.
// A closed draft shows as closed.
function stateLabel(change: CodeChangeSummaryReport, listed: ListedObject) {
  if (change.state !== "open") return change.state;
  if (!listed.settled) return undefined;
  return listedDraft(listed) ? "draft" : "open";
}

function stateTone(state: NonNullable<ReturnType<typeof stateLabel>>) {
  if (state === "merged") return "success" as const;
  if (state === "open") return "info" as const;
  return "neutral" as const;
}

/**
 * Show code changes, one row each, with their title, repository reference,
 * and state. An open change also shows the time since its last activity.
 * The rows read their live cards in one request.
 */
export function CodeChangeRows(props: {
  changes: readonly CodeChangeSummaryReport[];
}) {
  return (
    <MessageObjectsProvider>
      {props.changes.map((change) => (
        <CodeChangeRow change={change} key={change.id} />
      ))}
    </MessageObjectsProvider>
  );
}

function CodeChangeRow(props: { change: CodeChangeSummaryReport }) {
  const change = props.change;
  const title = change.title ?? `${change.repository} #${change.number}`;
  const listed = useListedObjects(change.state === "open" ? [change.url] : [])(
    change.url,
  );
  const state = stateLabel(change, listed);
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
      <div className="flex shrink-0 items-center gap-3">
        {change.state === "open" ? (
          <span className="font-mono text-xs text-dashboard-text-muted">
            <IdleText change={change} nowMs={Date.now()} />
          </span>
        ) : null}
        {state ? (
          <StatusChip size="compact" tone={stateTone(state)}>
            {state}
          </StatusChip>
        ) : (
          <span
            aria-hidden="true"
            className="inline-block h-5 w-12 animate-pulse rounded-md bg-dashboard-fill-soft motion-reduce:animate-none"
            data-code-change-state-pending=""
          />
        )}
      </div>
    </div>
  );
}
