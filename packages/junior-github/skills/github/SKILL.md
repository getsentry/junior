---
name: github
description: Manage GitHub issue workflows, source-code investigation, pull request operations, repository checkout, and implicit GitHub credentials via GitHub CLI with concise, evidence-backed content. Use when users ask to inspect implementation details in a repository, clone code, edit files, answer source-code questions from repo evidence, open/edit/view pull requests, or open/edit/inspect GitHub issues. Prefer this skill for repository and code tasks even when the repo concerns Sentry products.
uses-config: github.repo
allowed-tools: bash
---

# GitHub Operations

Issue workflows, pull request operations, and repository checkout via `gh` CLI.

## Reference loading

Load references conditionally based on the operation:

| Operation                                                        | Load                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any operation                                                    | [references/api-surface.md](references/api-surface.md)                                                                                                                                      |
| `clone`, `pull request create`                                   | [references/common-use-cases.md](references/common-use-cases.md)                                                                                                                            |
| `source-code investigation`                                      | [references/research-rules.md](references/research-rules.md)                                                                                                                                |
| `issue create`, `issue body rewrite`                             | [references/issue-examples.md](references/issue-examples.md), the matching type-specific template and type-specific rules, and [references/research-rules.md](references/research-rules.md) |
| `pull request inspection`, `pull request mutation`, `issue view` | [references/slack-render-intents.md](references/slack-render-intents.md) when Slack is the reply surface                                                                                    |
| On failure                                                       | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md)                                                                                                      |

## Workflow

### 1. Resolve operation and target

- Determine whether the task is `clone`, `source-code investigation`, an issue operation (`create`, `update`, `comment`, `labels`, `state`, or read-only inspection), a pull request inspection (`view`, `list`, `diff`, or `checks`), or a pull request mutation (`create`, `update`, `close`, or `merge`).
- Resolve repository (`owner/repo`). If it is not explicit, query channel config with `jr-rpc config get github.repo` before running any `gh` or `git` command.
- If config exists and is valid `owner/repo`, use it as the default and still pass it explicitly on subsequent `gh` commands instead of relying on ambient CLI context.
- If repository is still missing, ask the user for `owner/repo`.
- Resolve the issue number for non-create issue operations.
- Resolve the pull request number for pull request operations that target an existing PR.
- Keep `owner/repo` explicit on `gh` commands whenever the task targets a specific repository. This keeps the command pointed at the right repo and avoids accidental cross-repo mutations. Do not rely on a stale `github.repo` default when hopping between repos.

### 2. Execute by operation type

**Clone** → Follow the clone path below.
**Source-code investigation** → Follow the source-code path below.
**Issue operation** → Follow the issue path below.
**Pull request inspection** → Follow the pull request inspection path below.
**Pull request mutation** → Follow the pull request mutation path below.

---

### Clone path

- Default to a shallow clone.
- Use exact command forms from [references/api-surface.md](references/api-surface.md) or [references/common-use-cases.md](references/common-use-cases.md).
- Deepen incrementally only when the task needs repository history.
- After cloning, check for `AGENTS.md` in the repo root (and `.github/AGENTS.md`) before making edits. Treat discovered instructions as hard constraints.
- Report the local directory and whether the clone is shallow or full.

---

### Source-code investigation path

- Use this path for questions like "where is this implemented?", "how does this workflow work in code?", "is there already logic for X?", or "verify this from the repo."
- Resolve repository (`owner/repo`). If the current workspace already contains the target repository, inspect local files directly before cloning anything.
- If you need repository access outside the current workspace, keep `owner/repo` explicit on the authenticated command so the command itself targets the correct repository.
- Default to a shallow clone when you need a fresh checkout; deepen only if the question truly needs history.
- Prefer the narrowest deterministic evidence that answers the question: local file search, exact file reads, targeted clone inspection, existing issues/PRs, and tests.
- Cite repository evidence in the reply: file paths, symbols, issue/PR numbers, or commit references when known.
- If the available evidence is incomplete, say what is unknown instead of guessing.

---

### Issue path

#### 3. Classify issue type

- Use explicit user type when provided (`bug`, `feature`, `task`).
- Otherwise infer from intent:
  - `bug`: broken behavior, regression, error, failure.
  - `feature`: net-new capability or behavioral expansion.
  - `task`: maintenance, cleanup, docs, refactor, operational chore.
- Default to `task` when uncertain.

#### 4. Draft issue content

Load the type-specific template and rules:

| Type      | Template                                                                     | Research rules                                                       |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `bug`     | [references/issue-template-bug.md](references/issue-template-bug.md)         | [references/issue-type-bug.md](references/issue-type-bug.md)         |
| `feature` | [references/issue-template-feature.md](references/issue-template-feature.md) | [references/issue-type-feature.md](references/issue-type-feature.md) |
| `task`    | [references/issue-template-task.md](references/issue-template-task.md)       | [references/issue-type-task.md](references/issue-type-task.md)       |

Follow [references/research-rules.md](references/research-rules.md) for cross-type research standards.

- Use a short descriptive title for bugs, short imperative title for tasks and features.
- Mention who raised the issue when clear from the thread.
- Attach screenshots from the thread as image links when present.
- Prefer flat bullet lists over headed sections for simple issues.
- Do not add desired outcome or expected behavior unless the thread explicitly states one.
- Generalize conversation context: replace channel references, slash-command invocations, and session-specific fragments with the underlying technical problem.
- Use [references/issue-examples.md](references/issue-examples.md) to calibrate structure and depth.
- Include code snippets, related issues, and related PRs only when they materially improve the issue.

#### 5. Execute operation

- Use fully specified, non-interactive `gh` commands from [references/api-surface.md](references/api-surface.md).
- Use [references/common-use-cases.md](references/common-use-cases.md) only when you need a concrete command pattern.
- Check duplicates silently before creating a new issue. Only mention duplicates when relevant matches are actually found.
- Treat GitHub auth as plugin-owned and turn-scoped. The skill determines whether GitHub credentials are available for the turn; explicit repo flags are still for command correctness and mutation safety.

#### 6. Report result

- Return canonical issue URL, issue number, issue type, applied changes, and confidence.
- Include references used for verified claims.
- Keep routine issue-creation steps silent. Do not post progress chatter about duplicate checks, drafting, credential issuance, or command execution before the final result.
- Never mention silent duplicate checking in the final reply unless you actually found a relevant duplicate that changed the outcome.
- If duplicate checking found no relevant matches, omit that fact entirely and report only the created issue, for example `Created issue #123: ...`, not `No duplicates found. Creating the issue now.`

---

### Pull request inspection path

#### 3. Execute inspection

- Use exact read-only `gh pr` commands from [references/api-surface.md](references/api-surface.md).
- Skip branch resolution and push logic for inspection-only work.

#### 4. Report result

- Return canonical PR URL, PR number when available, target repository, and the fields the user asked to inspect.
- If the requested PR cannot be resolved, report the exact not-found or auth failure and stop.

---

### Pull request mutation path

#### 3. Resolve mutation inputs

- For PR creation, resolve the base branch. Use the explicit user request when present; otherwise use the repository default branch.
- For PR creation, resolve the head branch from the current checkout or user request.
- For PR creation, if the current branch may not exist on the remote yet, push it explicitly before PR creation.

#### 4. Execute pull request operation

- For PR creation, do not rely on `gh pr create` to push or fork implicitly.
- For PR creation, if the head branch is not already on the remote, run `git push` first. That push step needs GitHub write access for the remote repository.
- If `git push` returns 401, 403, or another auth/permission error, verify the command is still targeting the right repository and retry once. If the error still clearly indicates bad or revoked credentials, rerun the real GitHub command and let the runtime trigger a reconnect flow.
- After the branch exists remotely, run `gh pr create --repo owner/repo --head BRANCH ...`.
- For PR creation, use `--head` so `gh` skips its hidden push/fork flow.
- Treat `gh pr merge` as a contents mutation and keep repository context explicit so the command cannot hit the wrong repository.
- Treat issue comments and label edits as issue mutations and keep repository context explicit on the command.

#### 5. Report result

- Return canonical PR URL, PR number when available, target repository, and applied changes.
- If PR creation fails after explicit push + explicit repo scoping, report the exact auth or validation failure and stop.

## Guardrails

### Execution

- Execute operations as soon as required fields are available. Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.
- Do not overwrite issue fields unless explicitly requested. Prefer partial updates over full body replacement.

### Quality

- Never claim verification without citing sources.
- Answer source-code and implementation questions from repository evidence, not product framing or generic memory.
- For `bug` issues, do not present a fix as definitive unless root-cause evidence is explicit.
- If no relevant duplicates are found, continue directly to draft and create the issue, then report the created issue.

### Scope

- Issue workflows, pull request operations, and repository checkout. Do not execute repository admin mutations.
- Default to shallow clones. Do not use a full clone unless the task requires repository history or the user asks for it.
- If repository or installation access is missing, stop and return a concrete remediation message.
