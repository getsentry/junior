---
name: github-issues
description: Create, update, comment on, label, and inspect GitHub issues via GitHub CLI with concise, evidence-backed content. Use when users ask to open, edit, view, close, reopen, or triage GitHub issues — including tracking bugs, features, or tasks. Prefer this skill over generic repository tools for any issue operation.
allowed-tools: bash
---

# GitHub Issue Operations

Issue create, update, comment, label, state, and inspection via `gh` CLI.

## Reference loading

| Operation                            | Load                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any operation                        | [references/api-surface.md](references/api-surface.md)                                                                                                                                                                                                                                                 |
| `issue create`, `issue body rewrite` | [references/issue-examples.md](references/issue-examples.md), the matching type-specific guide ([issue-bug.md](references/issue-bug.md), [issue-feature.md](references/issue-feature.md), [issue-task.md](references/issue-task.md)), and [references/research-rules.md](references/research-rules.md) |
| On failure                           | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md)                                                                                                                                                                                                                 |

## Workflow

### 1. Resolve operation and target

- Determine whether the task is `create`, `update`, `comment`, `labels`, `state`, or read-only inspection.
- Resolve repository (`owner/repo`). If not explicit, query channel config with `jr-rpc config get github.repo` before running any `gh` command. If still missing, ask the user.
- Resolve the issue number for non-create operations.
- Keep `--repo owner/repo` explicit on `gh` commands so the command itself targets the intended repository, not a stale default.

### 2. Classify issue type

- Use explicit user type when provided (`bug`, `feature`, `task`).
- Otherwise infer from intent:
  - `bug`: broken behavior, regression, error, failure.
  - `feature`: net-new capability or behavioral expansion.
  - `task`: maintenance, cleanup, docs, refactor, operational chore.
- Default to `task` when uncertain.

### 3. Draft issue content

Load the type-specific guide:

| Type      | Guide                                                      |
| --------- | ---------------------------------------------------------- |
| `bug`     | [references/issue-bug.md](references/issue-bug.md)         |
| `feature` | [references/issue-feature.md](references/issue-feature.md) |
| `task`    | [references/issue-task.md](references/issue-task.md)       |

Follow [references/research-rules.md](references/research-rules.md) for cross-type research standards. Use [references/issue-examples.md](references/issue-examples.md) to calibrate structure and depth.

**Hard constraints — apply to every new issue:**

- Title ≤ 60 characters. Descriptive for bugs, imperative for tasks/features.
- Summary ≤ 3 sentences. Do not restate the title in the body.
- Prefer flat bullet lists over headed sections for simple issues. Remove empty sections.
- Generalize session framing — strip channel references, slash commands, Slack thread IDs, user @mentions, and transcript fragments; replace with the underlying technical problem.
- Compress source material. Research notes, hypotheses, or transcripts become a short summary + scoped bullets — never paste raw investigation into the body.
- Do not add desired outcome, expected behavior, or acceptance criteria unless the thread explicitly requests them.
- When the request originated from a Slack thread or any on-behalf-of context, append a final line `Action taken on behalf of <name>.` using the action requester's real name. The action requester is the current `<requester>` or the person who explicitly asked you to create/update the issue, not necessarily the original reporter.

**Attribution:**

- Mention who raised the issue when clear from the thread. If the reporter differs from the action requester, keep them separate with durable body text such as `Reported by Alice.` or `Raised by Alice during incident triage.`
- Attach screenshots from the thread as image links when present.
- Include code snippets, related issues, and related PRs only when they materially improve the issue.

### 4. Verify draft

Before running the `gh` create/edit command, check each gate. If any fails, revise and re-check before executing:

- Title length ≤ 60 characters.
- Delegated-action footer is the last line when applicable, using the action requester's real name, not the reporter's name unless they are the same person.
- No session framing remains (channel refs, slash commands, @mentions, Slack thread IDs).
- Body structure matches complexity — no empty sections, no restated title, no raw research dump.

Run [references/issue-quality-checklist.md](references/issue-quality-checklist.md) for holistic soft-signal review when the draft warrants it.

### 5. Execute

- Use `gh issue` commands from [references/api-surface.md](references/api-surface.md).
- Check duplicates silently before creating a new issue.

### 6. Report result

- Return canonical issue URL, issue number, issue type, and applied changes.

## Guardrails

- Require explicit confirmation only for close/reopen or destructive broad rewrites.
- Do not overwrite issue fields unless explicitly requested. Prefer partial updates over full body replacement.
- For `bug` issues, do not present a fix as definitive unless root-cause evidence is explicit.
- If repository or installation access is missing, stop and return a concrete remediation message.
