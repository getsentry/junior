import { Plus, Trash2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

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
  onChange(draft: WorkspaceDraft): void;
  onSubmit(): void;
};

const fieldClassName =
  "block w-full rounded border border-white/15 bg-black px-3 py-2 text-sm text-dashboard-text focus:border-[#beaaff] focus:outline-none";

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

  function removeRepo(key: string) {
    const repos = props.draft.repos.filter((repo) => repo.key !== key);
    props.onChange({
      ...props.draft,
      repos: repos.length > 0 ? repos : [createRepoDraft()],
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.canSave) props.onSubmit();
  }

  return (
    <Card padding="md" variant="section">
      <form className="grid gap-6" onSubmit={submit}>
        {props.editing ? (
          <div className="grid gap-1">
            <h2 className="m-0 text-base font-semibold text-dashboard-text">
              Configuration
            </h2>
            <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
              Change the recipe Junior uses the next time this Workspace is
              prepared.
            </p>
          </div>
        ) : null}

        <Field
          help="Lowercase name used when agents switch into this Workspace."
          htmlFor="workspace-name"
          label="Name"
        >
          <input
            autoComplete="off"
            className={fieldClassName}
            id="workspace-name"
            maxLength={64}
            onChange={(event) =>
              props.onChange({ ...props.draft, name: event.target.value })
            }
            placeholder="sentry"
            value={props.draft.name}
          />
        </Field>

        <section className="grid gap-3" aria-labelledby="workspace-repos-title">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-4">
            <div className="min-w-0 grid gap-1">
              <h3
                className="m-0 text-sm font-semibold text-dashboard-text"
                id="workspace-repos-title"
              >
                Repositories
              </h3>
              <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted sm:text-sm">
                Each repository clones to a fixed{" "}
                <code className="text-dashboard-text">repos/{"{name}"}</code>{" "}
                path. Junior loads{" "}
                <code className="text-dashboard-text">AGENTS.md</code> from each
                repository and labels those instructions with that directory.
              </p>
            </div>
            <Button
              className="w-full sm:w-auto"
              disabled={props.busy}
              onClick={() =>
                props.onChange({
                  ...props.draft,
                  repos: [...props.draft.repos, createRepoDraft()],
                })
              }
              type="button"
            >
              <Plus aria-hidden="true" size={14} />
              Add repository
            </Button>
          </div>

          <div className="grid gap-3">
            {props.draft.repos.map((repo, index) => (
              <div
                className="grid gap-3 rounded-lg border border-white/10 bg-black/20 p-3 sm:p-4"
                key={repo.key}
              >
                <div className="grid gap-3 sm:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_auto] sm:items-end">
                  <div className="grid gap-1.5">
                    <span className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
                      Provider
                    </span>
                    <input
                      aria-label={`Provider ${index + 1}`}
                      className={fieldClassName}
                      onChange={(event) =>
                        updateRepo(repo.key, { provider: event.target.value })
                      }
                      placeholder="github"
                      value={repo.provider}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <span className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
                      Repository
                    </span>
                    <input
                      aria-label={`Repository ${index + 1}`}
                      className={fieldClassName}
                      onChange={(event) =>
                        updateRepo(repo.key, { repo: event.target.value })
                      }
                      placeholder="getsentry/sentry"
                      value={repo.repo}
                    />
                  </div>
                  <button
                    aria-label={`Remove repository ${index + 1}`}
                    className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded border border-white/10 bg-transparent px-3 text-xs font-semibold text-dashboard-text-muted transition-colors hover:border-rose-300/40 hover:text-rose-300 sm:w-auto"
                    onClick={() => removeRepo(repo.key)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <Field
          help={
            <>
              Runs once while Junior builds the reusable snapshot. Current
              working directory is{" "}
              <code className="text-dashboard-text">$JUNIOR_WORKSPACE_ROOT</code>{" "}
              (the Sandbox root, usually{" "}
              <code className="text-dashboard-text">/vercel/sandbox</code>).
              Cloned repositories live under{" "}
              <code className="text-dashboard-text">$JUNIOR_REPOS_ROOT</code>{" "}
              (<code className="text-dashboard-text">$JUNIOR_WORKSPACE_ROOT/repos</code>
              ). Use those variables instead of hard-coded absolute paths.
            </>
          }
          htmlFor="workspace-setup"
          label="Setup script"
        >
          <textarea
            className={`${fieldClassName} min-h-36 font-mono`}
            id="workspace-setup"
            onChange={(event) =>
              props.onChange({
                ...props.draft,
                setupScript: event.target.value,
              })
            }
            placeholder={
              'pnpm install --dir "$JUNIOR_REPOS_ROOT/sentry"\n# cwd is $JUNIOR_WORKSPACE_ROOT'
            }
            value={props.draft.setupScript}
          />
        </Field>

        {props.error ? (
          <p className="m-0 text-sm text-rose-300" role="alert">
            {props.error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-5">
          <Button disabled={!props.canSave} type="submit">
            {props.busy
              ? "Saving…"
              : props.editing
                ? "Save changes"
                : "Create Workspace"}
          </Button>
          <p className="m-0 text-xs text-dashboard-text-muted">
            {props.editing
              ? "Saved changes apply the next time this Workspace is prepared."
              : "You can edit repositories and setup after create."}
          </p>
        </div>
      </form>
    </Card>
  );
}

function Field(props: {
  children: ReactNode;
  help: ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="grid gap-2">
      <label
        className="text-sm font-semibold text-dashboard-text"
        htmlFor={props.htmlFor}
      >
        {props.label}
      </label>
      {props.children}
      <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted sm:text-sm">
        {props.help}
      </p>
    </div>
  );
}
