import { ChevronRight, FolderGit2, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { Button } from "../../components/Button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { SelectableRow } from "../../components/SelectableRow";
import { Card } from "../../components/layout/Card";

type WorkspaceListProps = {
  busy: boolean;
  onDelete(workspace: WorkspaceReport): void;
  workspaces: WorkspaceReport[];
};

/** List Workspace recipes and expose their edit and delete actions. */
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
              busy={props.busy}
              key={workspace.id}
              onDelete={props.onDelete}
              workspace={workspace}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function WorkspaceListItem(props: {
  busy: boolean;
  onDelete(workspace: WorkspaceReport): void;
  workspace: WorkspaceReport;
}) {
  const { workspace } = props;
  const navigate = useNavigate();
  const openWorkspace = () =>
    navigate(`/system/workspaces/${encodeURIComponent(workspace.id)}`);
  return (
    <li className="border-b border-white/[0.055] last:border-b-0">
      <SelectableRow
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-3.5"
        onSelect={openWorkspace}
        selected={false}
      >
        <button
          aria-label={`Manage ${workspace.name}`}
          className="flex min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left"
          onClick={openWorkspace}
          type="button"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.03] text-[#beaaff] transition-colors group-hover:border-cyan-300/20 group-hover:bg-cyan-300/[0.06] group-hover:text-cyan-200">
            <FolderGit2 aria-hidden="true" size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-display text-base font-medium leading-tight text-dashboard-text">
                {workspace.name}
              </span>
              <span className="font-mono text-xs text-dashboard-text-muted">
                {workspace.repos.length} repo
                {workspace.repos.length === 1 ? "" : "s"}
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
        </button>
        <button
          aria-label={`Manage ${workspace.name}`}
          className="grid size-8 cursor-pointer place-items-center rounded border border-transparent bg-transparent text-dashboard-text-muted transition-colors hover:border-white/10 hover:bg-white/[0.04] hover:text-dashboard-text"
          onClick={openWorkspace}
          type="button"
        >
          <ChevronRight aria-hidden="true" size={16} />
        </button>
        <Button
          aria-label={`Delete ${workspace.name}`}
          disabled={props.busy}
          onClick={() => props.onDelete(workspace)}
          size="icon"
          title={`Delete ${workspace.name}`}
        >
          <Trash2 aria-hidden="true" size={15} />
        </Button>
      </SelectableRow>
    </li>
  );
}
