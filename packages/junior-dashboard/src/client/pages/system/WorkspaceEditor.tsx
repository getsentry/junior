import { Plus, Star, Trash2 } from "lucide-react";
import type { FormEvent } from "react";

import { Button } from "../../components/Button";
import { Card } from "../../components/layout/Card";
import {
  createRepoDraft,
  type RepoDraft,
  type WorkspaceDraft,
} from "./workspaceDraft";

type WorkspaceEditorProps = {
  busy: boolean;
  canSave: boolean;
  draft: WorkspaceDraft;
  error?: string;
  editing: boolean;
  onCancel(): void;
  onChange(draft: WorkspaceDraft): void;
  onSubmit(): void;
};

/** Edit one Workspace recipe without owning persistence. */
export function WorkspaceEditor(props: WorkspaceEditorProps) {
  function updateRepo(key: string, patch: Partial<RepoDraft>) {
    props.onChange({
      ...props.draft,
      repos: props.draft.repos.map((repo) =>
        repo.key === key ? { ...repo, ...patch } : repo,
      ),
    });
  }

  function setPrimary(key: string) {
    props.onChange({
      ...props.draft,
      repos: props.draft.repos.map((repo) => ({
        ...repo,
        isPrimary: repo.key === key,
      })),
    });
  }

  function removeRepo(key: string) {
    const repos = props.draft.repos.filter((repo) => repo.key !== key);
    if (repos.length === 0) {
      props.onChange({ ...props.draft, repos: [createRepoDraft(true)] });
      return;
    }
    if (!repos.some((repo) => repo.isPrimary)) {
      repos[0] = { ...repos[0]!, isPrimary: true };
    }
    props.onChange({ ...props.draft, repos });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.canSave) props.onSubmit();
  }

  return (
    <Card className="p-5" padding="none">
      <form className="space-y-5" onSubmit={submit}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="m-0 text-lg font-semibold">
              {props.editing ? "Edit Workspace" : "New Workspace"}
            </h3>
            <p className="mt-1 mb-0 text-sm text-dashboard-text-muted">
              Repositories use fixed <code>repos/{"{name}"}</code> paths. Mark
              one primary repository for AGENTS.md.
            </p>
          </div>
          <Button disabled={props.busy} onClick={props.onCancel} type="button">
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
            props.onChange({ ...props.draft, name: event.target.value })
          }
          placeholder="sentry"
          value={props.draft.name}
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="m-0 text-sm font-semibold">Repositories</h4>
            <Button
              disabled={props.busy}
              onClick={() =>
                props.onChange({
                  ...props.draft,
                  repos: [
                    ...props.draft.repos,
                    createRepoDraft(props.draft.repos.length === 0),
                  ],
                })
              }
              type="button"
            >
              <Plus aria-hidden="true" size={14} />
              Add repository
            </Button>
          </div>
          {props.draft.repos.map((repo, index) => (
            <div
              className="grid gap-2 rounded border border-white/10 p-3 md:grid-cols-[7rem_minmax(0,1fr)_auto]"
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
              <div className="flex items-center justify-end gap-2">
                <button
                  aria-label={`Mark repository ${index + 1} primary`}
                  aria-pressed={repo.isPrimary}
                  className={`inline-flex h-9 items-center justify-center gap-1 rounded border px-3 text-xs font-semibold uppercase ${
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
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded border border-white/10 bg-transparent text-dashboard-text-muted hover:border-rose-300/40 hover:text-rose-300"
                  onClick={() => removeRepo(repo.key)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={14} />
                </button>
              </div>
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
            props.onChange({ ...props.draft, setupScript: event.target.value })
          }
          placeholder={"pnpm install\n# repos live under $JUNIOR_REPOS_ROOT"}
          value={props.draft.setupScript}
        />
        <p className="mt-2 mb-0 text-xs text-dashboard-text-muted">
          Runs once during snapshot build with{" "}
          <code>JUNIOR_WORKSPACE_ROOT</code> and <code>JUNIOR_REPOS_ROOT</code>.
        </p>

        {props.error ? (
          <p className="m-0 text-sm text-rose-300" role="alert">
            {props.error}
          </p>
        ) : null}

        <Button disabled={!props.canSave} type="submit">
          {props.busy
            ? "Saving…"
            : props.editing
              ? "Save changes"
              : "Create Workspace"}
        </Button>
      </form>
    </Card>
  );
}
