import type { ReactNode } from "react";
import type { BaselineSnapshotReport } from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { formatMs, formatRelativeTime, formatTime } from "../../format";
import { formatSandboxSize } from "./SandboxSizeSummary";

/**
 * Show the base Sandbox: the default size and the baseline snapshot.
 * Workspaces inherit the base setup and use the default size unless they set
 * vCPUs.
 */
export function BaseSandboxCard(props: {
  defaultVcpus: number | null;
  snapshot: BaselineSnapshotReport | null;
}) {
  const snapshot = props.snapshot;
  return (
    <Card as="section" className="mb-0" padding="md" variant="section">
      <div aria-labelledby="base-sandbox-heading" className="grid gap-4">
        <div className="min-w-0 grid gap-1">
          <h2
            className="m-0 text-base font-semibold text-dashboard-text"
            id="base-sandbox-heading"
          >
            Base Sandbox
          </h2>
          <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
            The base snapshot is inherited by all Workspaces.
          </p>
        </div>

        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          <Fact label="Size">{formatSandboxSize(props.defaultVcpus)}</Fact>
          {snapshot ? (
            <>
              {snapshot.dependencyCount == null ? null : (
                <Fact label="Dependencies">{snapshot.dependencyCount}</Fact>
              )}
              <Fact label="Build time">
                {formatMs(snapshot.buildDurationMs)}
              </Fact>
              <Fact label="Generated">
                <span title={formatTime(snapshot.generatedAt)}>
                  {formatRelativeTime(snapshot.generatedAt)}
                </span>
              </Fact>
              <Fact label="Snapshot">
                <span className="break-all font-mono text-xs">
                  {snapshot.id}
                </span>
              </Fact>
            </>
          ) : (
            <Fact label="Snapshot">
              <span className="text-dashboard-text-muted">
                Not built yet. The first Sandbox without a Workspace builds it.
              </span>
            </Fact>
          )}
        </dl>
      </div>
    </Card>
  );
}

function Fact(props: { children: ReactNode; label: string }) {
  return (
    <div className="contents">
      <dt className="text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 tabular-nums text-dashboard-text">
        {props.children}
      </dd>
    </div>
  );
}
