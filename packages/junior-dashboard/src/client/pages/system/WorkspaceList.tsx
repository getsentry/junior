import { FolderGit2, Star, Trash2 } from "lucide-react";
import { Link } from "react-router";
import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
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
        <ul className="m-0 list-none divide-y divide-white/10 p-0">
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
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
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
              </span>
            ))
          )}
        </div>
      </div>
      <div className="col-start-2 row-start-2 flex items-center gap-2 sm:col-start-3 sm:row-start-1">
        <Link
          className="inline-flex h-9 items-center rounded border border-white/15 bg-dashboard-surface-raised px-3 font-mono text-sm font-semibold leading-none text-dashboard-text no-underline transition-colors hover:border-white/30 hover:bg-dashboard-surface-hover"
          to={`/system/workspaces/${encodeURIComponent(workspace.id)}`}
        >
          Manage
        </Link>
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
