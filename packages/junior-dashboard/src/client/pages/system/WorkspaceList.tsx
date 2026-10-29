import { ChevronRight, FolderGit2 } from "lucide-react";
import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { SelectableRow } from "../../components/SelectableRow";
import { Card } from "../../components/layout/Card";
import { formatSandboxSize } from "./sandboxSize";

type WorkspaceListProps = {
  defaultVcpus: number | null;
  onSelect(workspace: WorkspaceReport): void;
  selectedId: string | undefined;
  workspaces: WorkspaceReport[];
};

/** List Workspace recipes. Selecting a row opens its details. */
export function WorkspaceList(props: WorkspaceListProps) {
  return (
    <Card padding="none">
      {props.workspaces.length === 0 ? (
        <div className="p-5">
          <EmptyTelemetry>
            No Workspaces yet. Create one so agents can switch into a prepared
            multi-repo Sandbox.
          </EmptyTelemetry>
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {props.workspaces.map((workspace) => (
            <WorkspaceListItem
              defaultVcpus={props.defaultVcpus}
              key={workspace.id}
              onSelect={() => props.onSelect(workspace)}
              selected={workspace.id === props.selectedId}
              workspace={workspace}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function WorkspaceListItem(props: {
  defaultVcpus: number | null;
  onSelect(): void;
  selected: boolean;
  workspace: WorkspaceReport;
}) {
  const { workspace } = props;
  return (
    <li
      className="border-b border-dashboard-border-subtle last:border-b-0"
      data-workspace-id={workspace.id}
    >
      <SelectableRow
        className="px-4 py-3.5"
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <button
          aria-expanded={props.selected}
          aria-label={`View Workspace details: ${workspace.name}`}
          className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          onClick={props.onSelect}
          type="button"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-dashboard-border-strong bg-dashboard-fill-soft text-dashboard-accent transition-colors group-hover:border-dashboard-accent/20 group-hover:bg-dashboard-accent/[0.06] group-hover:text-dashboard-accent-text">
            <FolderGit2 aria-hidden="true" size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-display text-base font-medium leading-tight text-dashboard-text">
                {workspace.name}
              </span>
              <span className="font-mono text-xs text-dashboard-text-muted">
                {workspace.repos.length} repo
                {workspace.repos.length === 1 ? "" : "s"} ·{" "}
                {formatSandboxSize(workspace.vcpus ?? props.defaultVcpus)}
              </span>
            </span>
            <span className="mt-1.5 block truncate font-mono text-xs text-dashboard-text-muted">
              {workspace.repos.length
                ? workspace.repos
                    .map((repo) => `${repo.provider}:${repo.repo}`)
                    .join(" · ")
                : "No repositories"}
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            className="shrink-0 text-dashboard-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-dashboard-text"
            size={16}
          />
        </button>
      </SelectableRow>
    </li>
  );
}
