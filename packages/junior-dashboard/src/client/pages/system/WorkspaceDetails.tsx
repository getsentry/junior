import { Box, CalendarClock, Fingerprint, Timer } from "lucide-react";
import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { Detail, DetailList } from "../../components/DetailList";
import { Card } from "../../components/layout/Card";
import { formatMs, formatRelativeTime, formatTime } from "../../format";

/** Show the reusable Sandbox snapshot selected by one Workspace recipe. */
export function WorkspaceDetails(props: { workspace: WorkspaceReport }) {
  const { snapshot } = props.workspace;
  return (
    <Card padding="md" variant="section">
      <div className="grid gap-4">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.03] text-[#beaaff]">
            <Box aria-hidden="true" size={16} />
          </div>
          <div className="min-w-0 grid gap-1">
            <h2 className="m-0 text-base font-semibold text-dashboard-text">
              Current snapshot
            </h2>
            <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
              {snapshot
                ? "New Sandboxes start from this prepared snapshot."
                : "A snapshot is generated the first time Junior prepares this Workspace."}
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
                {snapshot.buildDurationMs == null
                  ? "unknown"
                  : formatMs(snapshot.buildDurationMs)}
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
            No snapshot generated yet. After the first successful prepare, the
            snapshot ID, generation time, and build duration appear here.
          </div>
        )}
      </div>
    </Card>
  );
}
