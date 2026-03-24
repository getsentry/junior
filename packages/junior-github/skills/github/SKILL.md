---
name: github
description: Manage GitHub issue workflows, pull request operations, and repository checkout via GitHub CLI with concise, evidence-backed content. Use when users ask to open, edit, label, comment on, close/reopen, or inspect GitHub issues, view or create pull requests, or when they need `gh repo clone` guidance, especially shallow-clone defaults and exact CLI commands.
requires-capabilities: github.issues.read github.issues.write github.issues.comment github.labels.write github.contents.read github.contents.write github.pull-requests.read github.pull-requests.write
uses-config: github.repo
allowed-tools: bash
---

# GitHub Operations

Issue workflows and repository checkout via `gh` CLI.

## Reference loading

Load references conditionally based on the operation:

| Operation          | Load                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Any operation      | [references/api-surface.md](references/api-surface.md)                                                                                       |
| `clone`            | [references/sandbox-runtime.md](references/sandbox-runtime.md)                                                                               |
| `create`           | Type-specific template + research rules (see step 3)                                                                                         |
| `create`, `update` | [references/issue-quality-checklist.md](references/issue-quality-checklist.md), [references/issue-examples.md](references/issue-examples.md) |
| On failure         | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md)                                                       |
| Credential issues  | [references/sandbox-runtime.md](references/sandbox-runtime.md)                                                                               |

## Workflow

### 1. Resolve operation and target

- Determine `clone`, `create`, `update`, `comment`, `labels`, `state`, or read-only inspection.
- Resolve repository (`owner/repo`) and issue number for non-create issue operations.
- If repository is not explicit in args, query channel config:
  - `jr-rpc config get github.repo`
- If config exists and is valid `owner/repo`, use it as default.
- If repository is still missing, ask the user for `owner/repo`.

### 2. Execute by operation type

**Clone** → Follow the clone path below.
**Issue operation** → Follow the issue path below.

---

### Clone path

- Issue a `contents.read` credential scoped to the target repository before cloning:
  - `jr-rpc issue-credential github.contents.read --repo owner/repo`
- Default to a shallow clone:
  - `gh repo clone owner/repo [directory] -- --depth=1`
- Pass extra `git clone` flags only after `--`.
- Use full-history clone only when the task needs `git blame`, `git bisect`, tag/release archaeology, or broad commit-log analysis.
- Deepen incrementally instead of recloning:
  - `git -C <directory> fetch --depth=<n> origin`
  - `git -C <directory> fetch --unshallow`
- When cloning a fork, keep the default upstream remote behavior unless the user asks otherwise.
- After cloning, check for `AGENTS.md` in the repo root (and `.github/AGENTS.md`) before making edits. Treat discovered instructions as hard constraints.
- Report the local directory and whether the clone is shallow or full.

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

Load the type-specific template and research rules:

| Type      | Template                                                                     | Research rules                                                       |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `bug`     | [references/issue-template-bug.md](references/issue-template-bug.md)         | [references/issue-type-bug.md](references/issue-type-bug.md)         |
| `feature` | [references/issue-template-feature.md](references/issue-template-feature.md) | [references/issue-type-feature.md](references/issue-type-feature.md) |
| `task`    | [references/issue-template-task.md](references/issue-template-task.md)       | [references/issue-type-task.md](references/issue-type-task.md)       |

Follow [references/research-rules.md](references/research-rules.md) for cross-type research standards.

- Generalize conversation context: replace user names, slash-command invocations, channel references, and session-specific fragments with the underlying technical problem.
- Include code snippets when they clarify the problem pattern or proposed change.
- Cross-reference related issues and PRs when they provide context.

#### 5. Execute operation

- Issue the matching capability credential before executing:
  - Repository checkout (`gh repo clone`): `github.contents.read`
  - Push commits/branches: `github.contents.write`
  - Read-only (`gh issue view`, comment reads via `gh api`): `github.issues.read`
  - Create/update/state changes: `github.issues.write`
  - Comments: `github.issues.comment`
  - Labels: `github.labels.write`
  - View PRs (`gh pr view`, `gh pr list`): `github.pull-requests.read`
  - Create/update/merge PRs: `github.pull-requests.write`
- Resolve command and flags from [references/api-surface.md](references/api-surface.md).
- Use [references/common-use-cases.md](references/common-use-cases.md) for ready-to-run operation patterns.

#### 6. Report result

- Return canonical issue URL, issue number, issue type, applied changes, and confidence.
- Include references used for verified claims.

## Guardrails

### Execution

- Execute operations as soon as required fields are available. Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.
- Do not overwrite issue fields unless explicitly requested. Prefer partial updates over full body replacement.

### Quality

- Never claim verification without citing sources.
- For `bug` issues, do not present a fix as definitive unless root-cause evidence is explicit.
- Do not report negative duplicate-search results to the user (e.g. "no duplicates found"). Searching for duplicates is expected, but only mention duplicates when matches are actually found and are relevant to surface.

### Scope

- Issue workflows, pull request operations, and repository checkout. Do not execute repository admin mutations.
- Default to shallow clones. Do not use a full clone unless the task requires repository history or the user asks for it.
- If repository or installation access is missing, stop and return a concrete remediation message.
