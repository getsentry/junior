import { FolderGit2, Star, Trash2 } from "lucide-react";
import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { Button } from "../../components/Button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { Card } from "../../components/layout/Card";

type WorkspaceListProps = {
  busy: boolean;
  onDelete(workspace: WorkspaceReport): void;
  onEdit(workspace: WorkspaceReport): void;
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
        <ul className="m-0 list-none divide-y divide-white/10 p-0">
          {props.workspaces.map((workspace) => (
            <WorkspaceListItem
              busy={props.busy}
              key={workspace.id}
              onDelete={props.onDelete}
              onEdit={props.onEdit}
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
  onEdit(workspace: WorkspaceReport): void;
  workspace: WorkspaceReport;
}) {
  const { workspace } = props;
  return (
    <li className="flex items-start gap-3 p-4">
      <div className="grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.03] text-[#beaaff]">
        <FolderGit2 aria-hidden="true" size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 text-sm font-semibold text-dashboard-text">
            {workspace.name}
          </p>
          <span className="font-mono text-xs text-dashboard-text-muted">
            {workspace.repos.length} repo
            {workspace.repos.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {workspace.repos.length === 0 ? (
            <span className="text-xs text-dashboard-text-muted">
              No repositories
            </span>
          ) : (
            workspace.repos.map((repo) => (
              <span
                className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 font-mono text-xs text-dashboard-text-muted"
                key={`${repo.provider}:${repo.repo}`}
              >
                {repo.isPrimary ? (
                  <Star
                    aria-label="Primary"
                    className="text-[#beaaff]"
                    size={12}
                  />
                ) : null}
                {repo.provider}:{repo.repo}
                <span className="text-dashboard-text-muted/70">
                  → {repo.checkoutPath}
                </span>
              </span>
            ))
          )}
        </div>
        {workspace.setupScript.trim() ? (
          <p className="mt-2 mb-0 line-clamp-2 font-mono text-xs text-dashboard-text-muted">
            {workspace.setupScript.trim()}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          disabled={props.busy}
          onClick={() => props.onEdit(workspace)}
          type="button"
        >
          Edit
        </Button>
        <button
          aria-label={`Delete ${workspace.name}`}
          className="inline-flex size-9 items-center justify-center rounded border border-white/10 bg-transparent text-dashboard-text-muted hover:border-rose-300/40 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={props.busy}
          onClick={() => props.onDelete(workspace)}
          type="button"
        >
          <Trash2 aria-hidden="true" size={14} />
        </button>
      </div>
    </li>
  );
}
