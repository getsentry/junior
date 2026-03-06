---
name: github
description: Manage GitHub issue workflows via GitHub App identity with concise, evidence-backed content. Use when users ask to open, edit, label, comment on, close/reopen, or inspect GitHub issues via /github.
requires-capabilities: github.issues.read github.issues.write github.issues.comment github.labels.write
uses-config: github.repo
---

# GitHub Operations

Use this skill for `/github` workflows in the harness. Issues are the primary supported surface today.

## Workflow

1. Confirm operation and target:
- Determine `create`, `update`, `comment`, `labels`, `state`, or read-only inspection.
- Resolve repository (`owner/repo`) and issue number for non-create operations.
- If repository is not explicit in args, query channel config:
  - `jr-rpc config get github.repo`
- If config exists and is valid `owner/repo`, use it as default.
- If repository is still missing, ask the user for `owner/repo`.

2. Classify issue type before drafting:
- Use explicit user type when provided (`bug`, `feature`, `task`).
- Otherwise infer from intent:
  - `bug`: broken behavior, regression, error, failure.
  - `feature`: net-new capability or behavioral expansion.
  - `task`: maintenance, cleanup, docs, refactor, operational chore.
- Default to `task` when uncertain.

3. Draft issue content:
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

4. Execute operation:
- Issue credential for the required capability before API calls:
  - Read-only (`get`, `list-comments`): `jr-rpc issue-credential github.issues.read`
  - Create/update/state changes: `jr-rpc issue-credential github.issues.write`
  - Comments: `jr-rpc issue-credential github.issues.comment`
  - Labels: `jr-rpc issue-credential github.labels.write`
- Call the API helper script (gh-backed). Read [references/github-issue-api.md](references/github-issue-api.md) for command shapes.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) for credential delivery details.

5. Report result:
- Return canonical issue URL, issue number, issue type, applied changes, and confidence.
- Include references used for verified claims.

## Guardrails

- Execute operations as soon as required fields are available. Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.
- Never claim verification without citing sources.
- For `bug` issues, do not present a fix as definitive unless root-cause evidence is explicit.
- Do not overwrite issue fields unless explicitly requested. Prefer partial updates over full body replacement.
- If repository or installation access is missing, stop and return a concrete remediation message.
