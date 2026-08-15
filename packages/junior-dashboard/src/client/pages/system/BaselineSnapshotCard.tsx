import { Box, CalendarClock, Fingerprint, Layers3, Timer } from "lucide-react";
import type { BaselineSnapshotReport } from "@sentry/junior/api/schema";

import { Detail, DetailList } from "../../components/DetailList";
import { Card } from "../../components/layout/Card";
import { formatMs, formatRelativeTime, formatTime } from "../../format";

/** Show the install-wide baseline Sandbox snapshot used without a Workspace. */
export function BaselineSnapshotCard(props: {
  snapshot: BaselineSnapshotReport | null;
}) {
  const { snapshot } = props;
  return (
    <Card padding="md" variant="section">
      <section
        aria-labelledby="baseline-snapshot-heading"
        className="grid gap-4"
      >
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.03] text-[#beaaff]">
            <Box aria-hidden="true" size={16} />
          </div>
          <div className="min-w-0 grid gap-1">
            <h2
              className="m-0 text-base font-semibold text-dashboard-text"
              id="baseline-snapshot-heading"
            >
              Baseline snapshot
            </h2>
            <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
              {snapshot
                ? "Default Sandboxes start from this install-wide snapshot when no Workspace is selected."
                : "No baseline snapshot is registered yet. Deploy-time warmup or the first base Sandbox prepare creates it."}
            </p>
          </div>
        </div>

        {snapshot ? (
          <DetailList className="sm:grid-cols-2">
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
            <Detail label="Dependencies">
              <span className="inline-flex items-center gap-2">
                <Layers3 aria-hidden="true" size={14} />
                {snapshot.dependencyCount}
              </span>
            </Detail>
            <Detail label="Snapshot ID" valueClassName="font-mono text-xs">
              <span className="inline-flex items-center gap-2 break-all">
                <Fingerprint aria-hidden="true" className="shrink-0" size={14} />
                {snapshot.id}
              </span>
            </Detail>
          </DetailList>
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-relaxed text-dashboard-text-muted">
            Missing baseline registry entry. Runtime can still build one on
            demand, but deploy warmup should publish it first.
          </div>
        )}
      </section>
    </Card>
  );
}
