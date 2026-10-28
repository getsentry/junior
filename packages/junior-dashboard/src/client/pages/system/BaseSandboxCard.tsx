import type { ReactNode } from "react";
import type { BaselineSnapshotReport } from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { formatMs, formatRelativeTime, formatTime } from "../../format";
import { formatSandboxSize } from "./SandboxSizeSummary";

/**
 * Show the base Sandbox: the default size and the baseline snapshot.
 * Workspaces use the default size unless they set vCPUs. They build their own
 * snapshot instead of the baseline snapshot.
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
            Used when a conversation has no Workspace. Workspaces use its size
            unless they set their own vCPUs. Each Workspace builds its own
            snapshot.
          </p>
        </div>

        <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2 text-sm">
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
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 tabular-nums text-dashboard-text">
        {props.children}
      </dd>
    </div>
  );
}
