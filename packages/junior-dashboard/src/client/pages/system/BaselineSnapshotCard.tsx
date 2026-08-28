import type { BaselineSnapshotReport } from "@sentry/junior/api/schema";

import { SnapshotSummary } from "./SnapshotSummary";

/** Show the install-wide baseline Sandbox snapshot used without a Workspace. */
export function BaselineSnapshotCard(props: {
  snapshot: BaselineSnapshotReport | null;
}) {
  return (
    <SnapshotSummary
      description="Default Sandboxes start from this install-wide snapshot when no Workspace is selected."
      emptyDescription="No baseline snapshot is registered yet. The first base Sandbox prepare creates one."
      headingId="baseline-snapshot-heading"
      snapshot={props.snapshot}
      title="Baseline snapshot"
    />
  );
}
