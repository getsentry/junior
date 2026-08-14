import { Box, CalendarClock, Fingerprint } from "lucide-react";
import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { Detail, DetailList } from "../../components/DetailList";
import { Card } from "../../components/layout/Card";
import { formatRelativeTime, formatTime } from "../../format";

/** Show the reusable Sandbox snapshot selected by one Workspace recipe. */
export function WorkspaceDetails(props: { workspace: WorkspaceReport }) {
  const { snapshot } = props.workspace;
  return (
    <Card className="p-5" padding="none">
      <div className="mb-4 flex items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.03] text-[#beaaff]">
          <Box aria-hidden="true" size={16} />
        </div>
        <div>
          <h2 className="m-0 text-base font-semibold">Current snapshot</h2>
          <p className="mt-1 mb-0 text-sm text-dashboard-text-muted">
            {snapshot
              ? "New Sandboxes start from this prepared snapshot."
              : "A snapshot will be generated when this Workspace is first used."}
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
          <Detail label="Snapshot ID" valueClassName="font-mono text-xs">
            <span className="inline-flex items-center gap-2 break-all">
              <Fingerprint aria-hidden="true" className="shrink-0" size={14} />
              {snapshot.id}
            </span>
          </Detail>
        </DetailList>
      ) : (
        <div className="rounded border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm text-dashboard-text-muted">
          No snapshot generated yet
        </div>
      )}
    </Card>
  );
}
