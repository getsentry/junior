---
name: github
description: Manage GitHub issue workflows and repository checkout via GitHub CLI with concise, evidence-backed content. Use when users ask to open, edit, label, comment on, close/reopen, or inspect GitHub issues, or when they need `gh repo clone` guidance, especially shallow-clone defaults and exact CLI commands.
requires-capabilities: github.issues.read github.issues.write github.issues.comment github.labels.write
uses-config: github.repo
allowed-tools: bash
---

# GitHub Operations

Use this skill for GitHub issue workflows in the harness. Issues are the primary surface. Repository checkout is limited to `gh repo clone` guidance and execution when local code context is needed.

## Workflow

1. Confirm operation and target:

- Determine `clone`, `create`, `update`, `comment`, `labels`, `state`, or read-only inspection.
- Resolve repository (`owner/repo`) and issue number for non-create issue operations.
- If repository is not explicit in args, query channel config:
  - `jr-rpc config get github.repo`
- If config exists and is valid `owner/repo`, use it as default.
- If repository is still missing, ask the user for `owner/repo`.

2. Handle repository checkout first when operation is `clone`:

- Default to a shallow clone for local inspection or one-off edits:
  - `gh repo clone owner/repo [directory] -- --depth=1`
- Pass extra `git clone` flags only after `--`.
- Use a full-history clone only when the task explicitly needs history-heavy operations such as `git blame`, `git bisect`, tag/release archaeology, or broad commit-log analysis.
- If the initial shallow clone is insufficient, deepen incrementally instead of recloning:
  - `git -C <directory> fetch --depth=<n> origin`
  - `git -C <directory> fetch --unshallow`
- When cloning a fork, keep the default upstream remote behavior unless the user asks for a different remote name.
- After checkout, report the local directory and whether the clone is shallow or full. Stop here for clone-only requests.

3. Classify issue type before drafting:

- Use explicit user type when provided (`bug`, `feature`, `task`).
- Otherwise infer from intent:
  - `bug`: broken behavior, regression, error, failure.
  - `feature`: net-new capability or behavioral expansion.
  - `task`: maintenance, cleanup, docs, refactor, operational chore.
- Default to `task` when uncertain.

4. Draft issue content:

- Load the type-specific template:
  - `bug`: [references/issue-template-bug.md](references/issue-template-bug.md)
  - `feature`: [references/issue-template-feature.md](references/issue-template-feature.md)
  - `task`: [references/issue-template-task.md](references/issue-template-task.md)
- Follow [references/research-rules.md](references/research-rules.md) and the type-specific research rules:
  - `bug`: [references/issue-type-bug.md](references/issue-type-bug.md)
  - `feature`: [references/issue-type-feature.md](references/issue-type-feature.md)
  - `task`: [references/issue-type-task.md](references/issue-type-task.md)
- Generalize conversation context: replace user names, slash-command invocations, channel references, and session-specific fragments with the underlying technical problem.
- Include code snippets when they clarify the problem pattern or proposed change.
- Cross-reference related issues and PRs when they provide context.
- For quality gates, use [references/issue-quality-checklist.md](references/issue-quality-checklist.md).
- For structure examples, use [references/issue-examples.md](references/issue-examples.md).
- When creating a new issue on behalf of a user, append a final attribution line at the end of the body in the form `Action taken on behalf of <name>.`
- Use the clearest available user identifier from conversation context. Prefer a human name, then stable handle, and do not omit attribution for delegated mutations.

5. Execute operation:

- Select the matching declared capability for the operation:
  - Read-only (`gh issue view`, comment reads via `gh api`): `github.issues.read`
  - Create/update/state changes: `github.issues.write`
  - Comments: `github.issues.comment`
  - Labels: `github.labels.write`
- Repository checkout does not need a GitHub issue capability. Use `gh repo clone` directly.
- Resolve command and flags from [references/api-surface.md](references/api-surface.md).
- Execute using `gh` CLI directly. Use [references/github-issue-api.md](references/github-issue-api.md) for exact command shapes.
- Use [references/common-use-cases.md](references/common-use-cases.md) for ready-to-run operation patterns.
- If an operation fails, follow [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) before retrying.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) when you need the GitHub CLI credential delivery details.

6. Report result:

- Return canonical issue URL, issue number, issue type, applied changes, and confidence for issue workflows.
- For clone operations, return the repository, local directory, clone mode (`shallow` or `full`), and any follow-up deepen/unshallow action taken.
- Include references used for verified claims.

## Guardrails

- Execute operations as soon as required fields are available. Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.
- Default to shallow clones for efficiency. Do not use a full clone unless the task requires repository history or the user asks for it.
- Never claim verification without citing sources.
- For `bug` issues, do not present a fix as definitive unless root-cause evidence is explicit.
- Do not overwrite issue fields unless explicitly requested. Prefer partial updates over full body replacement.
- If repository or installation access is missing, stop and return a concrete remediation message.
- Scope is issue workflows plus repository checkout. Do not execute pull-request or repository admin mutations in this skill.
