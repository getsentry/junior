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

3. Draft concise issue content:
- Start from [references/issue-template.md](references/issue-template.md), then apply the type-specific variant:
  - `bug`: [references/issue-template-bug.md](references/issue-template-bug.md)
  - `feature`: [references/issue-template-feature.md](references/issue-template-feature.md)
  - `task`: [references/issue-template-task.md](references/issue-template-task.md)
- Keep content short and scannable.
- Do not add acceptance-criteria checklists unless explicitly requested.
- Include concerns only when material risk, uncertainty, or dependency exists.
- Generalize conversation context: replace user names, slash-command invocations, channel references, and session-specific fragments with the underlying technical problem. The issue must be actionable without access to the originating conversation.
- Include code snippets when they clarify the problem pattern or proposed change.
- Cross-reference related issues and PRs when they provide context.

4. Enforce concise usability limits:
- Title must be specific and outcome-oriented.
- Title hard max: 60 characters. Target: 40-60.
- If user-provided title exceeds 60 characters, rewrite concisely while preserving intent.
- Body guidelines:
  - Summary max 3 sentences.
  - Prefer concise sections but use as many bullets, steps, or rows as the problem requires.
  - Include code snippets, tables, or numbered steps when they add clarity.

5. Research and verify factual claims:
- Follow [references/research-rules.md](references/research-rules.md).
- Apply type-specific research rules:
  - `bug`: [references/issue-type-bug.md](references/issue-type-bug.md)
  - `feature`: [references/issue-type-feature.md](references/issue-type-feature.md)
  - `task`: [references/issue-type-task.md](references/issue-type-task.md)
- Prefer first-party evidence (repo code, issues, docs, changelogs).
- Mark uncertain statements as unknown instead of presenting guesses as facts.
- For quality gates, use [references/issue-quality-checklist.md](references/issue-quality-checklist.md).
- For structure examples, use [references/issue-examples.md](references/issue-examples.md).

6. Mutate by default (no preview gate):
- Execute create/update/comment/labels operations as soon as required fields are available.
- Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.

7. Call GitHub API helper script:
- Use `scripts/gh_issue_api.mjs` for issue API operations.
- Before authenticated GitHub API calls in this turn, run:
  - For read-only issue inspection (`get`, `list-comments`): `jr-rpc issue-credential github.issues.read`
  - For issue create/update/state changes: `jr-rpc issue-credential github.issues.write`
  - For comments: `jr-rpc issue-credential github.issues.comment`
  - For labels: `jr-rpc issue-credential github.labels.write`
- Then run normal `bash` commands; sandbox runtime applies scoped Authorization headers for this turn.
- Do not pass raw tokens into the sandbox.
- Required pattern:
  - `jr-rpc issue-credential <capability>`
  - `node /vercel/sandbox/skills/github/scripts/gh_issue_api.mjs ...`
- Read [references/github-issue-api.md](references/github-issue-api.md) for command shapes.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) before relying on sandbox credentials.

8. Report result:
- Return canonical issue URL, issue number, issue type, applied changes, and confidence.
- Include references used for verified claims.

## Guardrails

- Never claim verification without citing sources.
- For `bug` issues, do not present a fix as definitive unless root-cause evidence is explicit.
- Do not overwrite issue fields unless explicitly requested.
- Prefer partial updates over full body replacement.
- If repository or installation access is missing, stop and return a concrete remediation message.
