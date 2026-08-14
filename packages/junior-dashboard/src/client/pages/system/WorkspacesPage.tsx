import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Plus, Star, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import {
  workspaceListSchema,
  workspaceSchema,
  type WorkspaceReport,
} from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../../agentName";
import { Button } from "../../components/Button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import {
  DashboardApiError,
  deleteDashboardResource,
  fetchDashboardJson,
  post,
  put,
} from "../../http";
import { SystemPageLayout } from "./SystemPageLayout";

const workspacesQueryKey = ["dashboard", "workspaces"] as const;

type RepoDraft = {
  key: string;
  provider: string;
  repo: string;
  isPrimary: boolean;
};

type WorkspaceDraft = {
  name: string;
  setupScript: string;
  repos: RepoDraft[];
};

function blankRepo(isPrimary = false): RepoDraft {
  return {
    key: crypto.randomUUID(),
    provider: "github",
    repo: "",
    isPrimary,
  };
}

function blankDraft(): WorkspaceDraft {
  return {
    name: "",
    setupScript: "",
    repos: [blankRepo(true)],
  };
}

function draftFromWorkspace(workspace: WorkspaceReport): WorkspaceDraft {
  return {
    name: workspace.name,
    setupScript: workspace.setupScript,
    repos:
      workspace.repos.length > 0
        ? workspace.repos.map((repo) => ({
            key: crypto.randomUUID(),
            provider: repo.provider,
            repo: repo.repo,
            isPrimary: repo.isPrimary,
          }))
        : [blankRepo(true)],
  };
}

function serializeDraft(draft: WorkspaceDraft) {
  return {
    name: draft.name.trim(),
    setupScript: draft.setupScript,
    repos: draft.repos.map((repo) => ({
      provider: repo.provider.trim(),
      repo: repo.repo.trim(),
      isPrimary: repo.isPrimary,
    })),
  };
}

function readApiError(error: unknown, fallback: string): string {
  if (error instanceof DashboardApiError) {
    return error.apiError ?? fallback;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/** Manage install-wide repository Workspace recipes. */
export function WorkspacesPage() {
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkspaceDraft>(blankDraft);
  const [formError, setFormError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  const workspacesQuery = useQuery({
    queryKey: workspacesQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(workspaceListSchema, "/api/workspaces", signal),
    retry: false,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = serializeDraft(draft);
      if (editingId) {
        return put(
          workspaceSchema,
          `/api/workspaces/${encodeURIComponent(editingId)}`,
          body,
        );
      }
      return post(workspaceSchema, "/api/workspaces", body);
    },
    onSuccess: async (workspace) => {
      setFormError(undefined);
      setActionError(undefined);
      setEditorOpen(false);
      setEditingId(null);
      setDraft(blankDraft());
      await queryClient.cancelQueries({ queryKey: workspacesQueryKey });
      queryClient.setQueryData<{ workspaces: WorkspaceReport[] }>(
        workspacesQueryKey,
        (current) => {
          const existing = current?.workspaces ?? [];
          const next = [
            workspace,
            ...existing.filter((item) => item.id !== workspace.id),
          ].sort((left, right) => left.name.localeCompare(right.name));
          return { workspaces: next };
        },
      );
    },
    onError: (error) => {
      setFormError(
        readApiError(error, "Could not save the Workspace. Try again."),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (workspace: WorkspaceReport) =>
      deleteDashboardResource(
        `/api/workspaces/${encodeURIComponent(workspace.id)}`,
      ).then(() => workspace),
    onSuccess: async (workspace) => {
      setActionError(undefined);
      if (editingId === workspace.id) {
        setEditorOpen(false);
        setEditingId(null);
        setDraft(blankDraft());
      }
      await queryClient.cancelQueries({ queryKey: workspacesQueryKey });
      queryClient.setQueryData<{ workspaces: WorkspaceReport[] }>(
        workspacesQueryKey,
        (current) => ({
          workspaces: (current?.workspaces ?? []).filter(
            (item) => item.id !== workspace.id,
          ),
        }),
      );
    },
    onError: (error) => {
      setActionError(
        readApiError(error, "Could not delete the Workspace. Try again."),
      );
    },
  });

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const busy = saveMutation.isPending || deleteMutation.isPending;
  const canSave = useMemo(() => {
    if (!draft.name.trim()) return false;
    if (draft.repos.some((repo) => !repo.provider.trim() || !repo.repo.trim())) {
      return false;
    }
    if (draft.repos.length > 0 && !draft.repos.some((repo) => repo.isPrimary)) {
      return false;
    }
    return !busy;
  }, [busy, draft]);

  function openCreate() {
    setEditingId(null);
    setDraft(blankDraft());
    setFormError(undefined);
    setEditorOpen(true);
  }

  function openEdit(workspace: WorkspaceReport) {
    setEditingId(workspace.id);
    setDraft(draftFromWorkspace(workspace));
    setFormError(undefined);
    setEditorOpen(true);
  }

  function updateRepo(key: string, patch: Partial<RepoDraft>) {
    setDraft((current) => ({
      ...current,
      repos: current.repos.map((repo) =>
        repo.key === key ? { ...repo, ...patch } : repo,
      ),
    }));
  }

  function setPrimary(key: string) {
    setDraft((current) => ({
      ...current,
      repos: current.repos.map((repo) => ({
        ...repo,
        isPrimary: repo.key === key,
      })),
    }));
  }

  function removeRepo(key: string) {
    setDraft((current) => {
      const remaining = current.repos.filter((repo) => repo.key !== key);
      if (remaining.length === 0) return { ...current, repos: [blankRepo(true)] };
      if (!remaining.some((repo) => repo.isPrimary)) {
        remaining[0] = { ...remaining[0]!, isPrimary: true };
      }
      return { ...current, repos: remaining };
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setFormError(undefined);
    saveMutation.mutate();
  }

  if (!workspacesQuery.data && !workspacesQuery.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading Workspaces" />
      </SystemPageLayout>
    );
  }

  return (
    <SystemPageLayout>
      <PageHeader
        actions={
          <Button disabled={busy} onClick={openCreate}>
            <Plus aria-hidden="true" size={14} />
            New Workspace
          </Button>
        }
        description={`Named repository recipes ${getDashboardAgentName()} can switch into without cloning each turn.`}
        title="Workspaces"
      />

      {workspacesQuery.error ? (
        <Card padding="sm">
          <EmptyTelemetry>
            Workspaces failed to load. Try refreshing the dashboard.
          </EmptyTelemetry>
        </Card>
      ) : null}

      {actionError ? (
        <p className="m-0 text-sm text-rose-300" role="alert">
          {actionError}
        </p>
      ) : null}

      {editorOpen ? (
        <Card className="p-5" padding="none">
          <form className="space-y-5" onSubmit={submit}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="m-0 text-lg font-semibold">
                  {editingId ? "Edit Workspace" : "New Workspace"}
                </h3>
                <p className="mt-1 mb-0 text-sm text-dashboard-text-muted">
                  Repositories land at fixed `repos/{"{name}"}` paths. Mark one
                  primary repo for AGENTS.md.
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={() => {
                  setEditorOpen(false);
                  setEditingId(null);
                  setFormError(undefined);
                }}
                type="button"
              >
                Cancel
              </Button>
            </div>

            <label className="block text-sm font-semibold" htmlFor="workspace-name">
              Name
            </label>
            <input
              autoComplete="off"
              className="mt-2 block w-full rounded border border-white/15 bg-black px-3 py-2 text-sm text-dashboard-text focus:border-[#beaaff] focus:outline-none"
              id="workspace-name"
              maxLength={64}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="sentry"
              value={draft.name}
            />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="m-0 text-sm font-semibold">Repositories</h4>
                <Button
                  disabled={busy}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      repos: [
                        ...current.repos,
                        blankRepo(current.repos.length === 0),
                      ],
                    }))
                  }
                  type="button"
                >
                  <Plus aria-hidden="true" size={14} />
                  Add repo
                </Button>
              </div>
              {draft.repos.map((repo, index) => (
                <div
                  className="grid gap-2 rounded border border-white/10 p-3 md:grid-cols-[7rem_minmax(0,1fr)_auto_auto]"
                  key={repo.key}
                >
                  <input
                    aria-label={`Provider ${index + 1}`}
                    className="rounded border border-white/15 bg-black px-3 py-2 text-sm text-dashboard-text focus:border-[#beaaff] focus:outline-none"
                    onChange={(event) =>
                      updateRepo(repo.key, { provider: event.target.value })
                    }
                    placeholder="github"
                    value={repo.provider}
                  />
                  <input
                    aria-label={`Repository ${index + 1}`}
                    className="min-w-0 rounded border border-white/15 bg-black px-3 py-2 text-sm text-dashboard-text focus:border-[#beaaff] focus:outline-none"
                    onChange={(event) =>
                      updateRepo(repo.key, { repo: event.target.value })
                    }
                    placeholder="getsentry/sentry"
                    value={repo.repo}
                  />
                  <button
                    aria-label={`Mark repository ${index + 1} primary`}
                    aria-pressed={repo.isPrimary}
                    className={`inline-flex items-center justify-center gap-1 rounded border px-3 py-2 text-xs font-semibold uppercase ${
                      repo.isPrimary
                        ? "border-[#beaaff]/50 bg-[#beaaff]/15 text-[#beaaff]"
                        : "border-white/10 bg-transparent text-dashboard-text-muted hover:border-white/25 hover:text-dashboard-text"
                    }`}
                    onClick={() => setPrimary(repo.key)}
                    type="button"
                  >
                    <Star aria-hidden="true" size={14} />
                    Primary
                  </button>
                  <button
                    aria-label={`Remove repository ${index + 1}`}
                    className="inline-flex items-center justify-center rounded border border-white/10 bg-transparent px-3 py-2 text-dashboard-text-muted hover:border-rose-300/40 hover:text-rose-300"
                    onClick={() => removeRepo(repo.key)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
              ))}
            </div>

            <label
              className="block text-sm font-semibold"
              htmlFor="workspace-setup"
            >
              Setup script
            </label>
            <textarea
              className="mt-2 block min-h-32 w-full rounded border border-white/15 bg-black px-3 py-2 font-mono text-sm text-dashboard-text focus:border-[#beaaff] focus:outline-none"
              id="workspace-setup"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  setupScript: event.target.value,
                }))
              }
              placeholder={"pnpm install\n# repos live under $JUNIOR_REPOS_ROOT"}
              value={draft.setupScript}
            />
            <p className="mt-2 mb-0 text-xs text-dashboard-text-muted">
              Runs once during snapshot build with `JUNIOR_WORKSPACE_ROOT` and
              `JUNIOR_REPOS_ROOT`.
            </p>

            {formError ? (
              <p className="m-0 text-sm text-rose-300" role="alert">
                {formError}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <Button disabled={!canSave} type="submit">
                {saveMutation.isPending
                  ? "Saving…"
                  : editingId
                    ? "Save changes"
                    : "Create Workspace"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card padding="none">
        {workspaces.length === 0 ? (
          <div className="p-5">
            <EmptyTelemetry>
              No Workspaces yet. Create one so agents can switch into a prepared
              multi-repo Sandbox.
            </EmptyTelemetry>
          </div>
        ) : (
          <ul className="m-0 list-none divide-y divide-white/10 p-0">
            {workspaces.map((workspace) => (
              <li className="flex items-start gap-3 p-4" key={workspace.id}>
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
                    disabled={busy}
                    onClick={() => openEdit(workspace)}
                    type="button"
                  >
                    Edit
                  </Button>
                  <button
                    aria-label={`Delete ${workspace.name}`}
                    className="inline-flex size-9 items-center justify-center rounded border border-white/10 bg-transparent text-dashboard-text-muted hover:border-rose-300/40 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete Workspace “${workspace.name}”? Active conversations keep their current Sandbox until the next switch.`,
                        )
                      ) {
                        return;
                      }
                      deleteMutation.mutate(workspace);
                    }}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </SystemPageLayout>
  );
}
