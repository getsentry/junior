import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { SnapshotSummary } from "./SnapshotSummary";

/** Show the reusable Sandbox snapshot selected by one Workspace recipe. */
export function WorkspaceDetails(props: { workspace: WorkspaceReport }) {
  return (
    <SnapshotSummary
      description="New Sandboxes start from this prepared snapshot."
      emptyDescription="No snapshot yet. The first successful prepare creates one."
      headingId="workspace-snapshot-heading"
      snapshot={props.workspace.snapshot}
      title="Current snapshot"
    />
  );
}
