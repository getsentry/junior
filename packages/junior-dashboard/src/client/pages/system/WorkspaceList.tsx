import { ArrowRight, FolderGit2, Trash2 } from "lucide-react";
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
  return (
    <li className="group relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-white/[0.055] p-4 transition-colors last:border-b-0 hover:bg-white/[0.035] focus-within:bg-white/[0.035]">
      <Link
        aria-label={`Manage ${workspace.name}`}
        className="absolute inset-0 z-0 no-underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 focus-visible:outline-offset-[-1px]"
        to={`/system/workspaces/${encodeURIComponent(workspace.id)}`}
      />
      <div className="pointer-events-none relative z-10 grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.03] text-[#beaaff] transition-colors group-hover:border-cyan-300/20 group-hover:bg-cyan-300/[0.06] group-hover:text-cyan-200">
        <FolderGit2 aria-hidden="true" size={16} />
      </div>
      <div className="pointer-events-none relative z-10 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 font-display text-base font-medium leading-tight text-dashboard-text">
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
                {repo.provider}:{repo.repo}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ArrowRight
          aria-hidden="true"
          className="pointer-events-none relative z-10 text-dashboard-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-cyan-200/70"
          size={16}
        />
        <button
          aria-label={`Delete ${workspace.name}`}
          className="relative z-10 inline-flex size-9 items-center justify-center rounded border border-white/10 bg-transparent text-dashboard-text-muted hover:border-rose-300/40 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
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
