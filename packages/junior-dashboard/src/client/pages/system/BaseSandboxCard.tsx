import { Cpu } from "lucide-react";
import type { ReactNode } from "react";
import type { BaselineSnapshotReport } from "@sentry/junior/api/schema";

import { Detail, DetailList } from "../../components/DetailList";
import { Card } from "../../components/layout/Card";
import { StatusChip, type StatusChipTone } from "../../components/StatusChip";
import { formatSandboxSize } from "./SandboxSizeSummary";
import { SnapshotDetails } from "./SnapshotSummary";

/**
 * Show the base Sandbox in one card and mark what Workspaces share with it.
 * Workspaces use the base size unless they set vCPUs. They never use the
 * baseline snapshot.
 */
export function BaseSandboxCard(props: {
  defaultVcpus: number | null;
  snapshot: BaselineSnapshotReport | null;
}) {
  return (
    <Card as="section" className="mb-0" padding="md" variant="section">
      <div aria-labelledby="base-sandbox-heading" className="grid gap-5">
        <div className="min-w-0 grid gap-1">
          <h2
            className="m-0 text-base font-semibold text-dashboard-text"
            id="base-sandbox-heading"
          >
            Base Sandbox
          </h2>
          <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
            Junior uses this Sandbox when a conversation has no Workspace.
          </p>
        </div>

        <BaseSandboxSection
          description="Workspaces use this size unless they set their own vCPUs."
          headingId="base-sandbox-size-heading"
          scope="Shared with Workspaces"
          scopeTone="accent"
          title="Size"
        >
          <DetailList>
            <Detail label="vCPUs and memory">
              <span className="inline-flex items-center gap-2">
                <Cpu aria-hidden="true" size={14} />
                {formatSandboxSize(props.defaultVcpus)}
              </span>
            </Detail>
          </DetailList>
        </BaseSandboxSection>

        <BaseSandboxSection
          description={
            props.snapshot
              ? "Each Workspace builds its own snapshot from its repos and setup script."
              : "No baseline snapshot yet. The first Sandbox without a Workspace creates one. Each Workspace builds its own snapshot."
          }
          headingId="baseline-snapshot-heading"
          scope="Base only"
          scopeTone="neutral"
          title="Baseline snapshot"
        >
          {props.snapshot ? (
            <SnapshotDetails snapshot={props.snapshot} />
          ) : null}
        </BaseSandboxSection>
      </div>
    </Card>
  );
}

function BaseSandboxSection(props: {
  children: ReactNode;
  description: string;
  headingId: string;
  scope: string;
  scopeTone: StatusChipTone;
  title: string;
}) {
  return (
    <section
      aria-labelledby={props.headingId}
      className="grid gap-3 border-t border-dashboard-border-subtle pt-4"
    >
      <div className="min-w-0 grid gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3
            className="m-0 text-sm font-semibold text-dashboard-text"
            id={props.headingId}
          >
            {props.title}
          </h3>
          <StatusChip size="compact" tone={props.scopeTone}>
            {props.scope}
          </StatusChip>
        </div>
        <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted sm:text-sm">
          {props.description}
        </p>
      </div>
      {props.children}
    </section>
  );
}
