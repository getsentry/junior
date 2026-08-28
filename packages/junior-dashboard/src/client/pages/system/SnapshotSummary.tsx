import { CalendarClock, Fingerprint, Layers3, Timer } from "lucide-react";

import { Detail, DetailList } from "../../components/DetailList";
import { Card } from "../../components/layout/Card";
import { formatMs, formatRelativeTime, formatTime } from "../../format";

type SnapshotSummaryValue = {
  buildDurationMs: number;
  dependencyCount?: number;
  generatedAt: string;
  id: string;
};

/** Show one reusable Sandbox snapshot in the shared System summary surface. */
export function SnapshotSummary(props: {
  description: string;
  emptyDescription: string;
  headingId: string;
  snapshot: SnapshotSummaryValue | null;
  title: string;
}) {
  const snapshot = props.snapshot;
  const gridClassName =
    snapshot?.dependencyCount == null
      ? "sm:grid-cols-3"
      : "sm:grid-cols-2 lg:grid-cols-4";

  return (
    <Card as="section" className="mb-0" padding="md" variant="section">
      <div aria-labelledby={props.headingId} className="grid gap-4">
        <div className="min-w-0 grid gap-1">
          <h2
            className="m-0 text-base font-semibold text-dashboard-text"
            id={props.headingId}
          >
            {props.title}
          </h2>
          <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
            {snapshot ? props.description : props.emptyDescription}
          </p>
        </div>

        {snapshot ? (
          <DetailList className={gridClassName}>
            <Detail label="Generated">
              <span className="inline-flex items-center gap-2">
                <CalendarClock aria-hidden="true" size={14} />
                <span title={formatTime(snapshot.generatedAt)}>
                  {formatRelativeTime(snapshot.generatedAt)}
                </span>
              </span>
            </Detail>
            <Detail label="Build time">
              <span className="inline-flex items-center gap-2">
                <Timer aria-hidden="true" size={14} />
                {formatMs(snapshot.buildDurationMs)}
              </span>
            </Detail>
            {snapshot.dependencyCount == null ? null : (
              <Detail label="Dependencies">
                <span className="inline-flex items-center gap-2">
                  <Layers3 aria-hidden="true" size={14} />
                  {snapshot.dependencyCount}
                </span>
              </Detail>
            )}
            <Detail label="Snapshot ID" valueClassName="font-mono text-xs">
              <span className="inline-flex items-center gap-2 break-all">
                <Fingerprint aria-hidden="true" className="shrink-0" size={14} />
                {snapshot.id}
              </span>
            </Detail>
          </DetailList>
        ) : null}
      </div>
    </Card>
  );
}
