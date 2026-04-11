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

| Operation          | Load                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any operation      | [references/api-surface.md](references/api-surface.md)                                                                                                                                      |
| `clone`            | [references/common-use-cases.md](references/common-use-cases.md)                                                                                                                            |
| `create`, `update` | [references/issue-examples.md](references/issue-examples.md), the matching type-specific template and type-specific rules, and [references/research-rules.md](references/research-rules.md) |
| On failure         | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md)                                                                                                      |

## Workflow

### 1. Resolve operation and target

- Determine whether the task is `clone` or an issue operation (`create`, `update`, `comment`, `labels`, `state`, or read-only inspection).
- Resolve repository (`owner/repo`). If it is not explicit, query channel config with `jr-rpc config get github.repo`.
- If config exists and is valid `owner/repo`, use it as the default.
- If repository is still missing, ask the user for `owner/repo`.
- Resolve the issue number for non-create issue operations.

### 2. Execute by operation type

**Clone** → Follow the clone path below.
**Issue operation** → Follow the issue path below.

---

### Clone path

- Issue a `contents.read` credential scoped to the target repository before cloning:
  - `jr-rpc issue-credential github.contents.read --repo owner/repo`
- Default to a shallow clone.
- Use exact command forms from [references/api-surface.md](references/api-surface.md) or [references/common-use-cases.md](references/common-use-cases.md).
- Deepen incrementally only when the task needs repository history.
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

- Issue the narrowest matching capability credential before executing.
- Use fully specified, non-interactive `gh` commands from [references/api-surface.md](references/api-surface.md).
- Use [references/common-use-cases.md](references/common-use-cases.md) only when you need a concrete command pattern.
- Check duplicates silently before creating a new issue. Only mention duplicates when relevant matches are actually found.

#### 6. Report result

- Return canonical issue URL, issue number, issue type, applied changes, and confidence.
- Include references used for verified claims.
- Keep routine issue-creation steps silent. Do not post progress chatter about duplicate checks, drafting, credential issuance, or command execution before the final result.
- If duplicate checking found no relevant matches, omit that fact entirely and report only the created issue, for example `Created issue #123: ...`, not `No duplicates found. Creating the issue now.`

## Guardrails

### Execution

- Execute operations as soon as required fields are available. Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.
- Do not overwrite issue fields unless explicitly requested. Prefer partial updates over full body replacement.

### Quality

- Never claim verification without citing sources.
- For `bug` issues, do not present a fix as definitive unless root-cause evidence is explicit.
- If no relevant duplicates are found, continue directly to draft and create the issue, then report the created issue.

### Scope

- Issue workflows, pull request operations, and repository checkout. Do not execute repository admin mutations.
- Default to shallow clones. Do not use a full clone unless the task requires repository history or the user asks for it.
- If repository or installation access is missing, stop and return a concrete remediation message.
