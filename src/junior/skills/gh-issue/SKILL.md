---
name: gh-issue
description: Create and update GitHub issues via GitHub App identity with evidence-backed issue content. Use when users ask to open, edit, label, comment on, or close/reopen GitHub issues and want accurate, source-verified writeups.
requires-capabilities: github.issues.read github.issues.write github.issues.comment github.labels.write
uses-config: github.repo
---

# GitHub Issue Operations

Use this skill for `/gh-issue` workflows in the harness.

## Workflow

1. Confirm operation and target:
- Determine `create`, `update`, `comment`, `labels`, or `state` action.
- Resolve repository (`owner/repo`) and issue number for non-create operations.

2. Classify issue type before drafting:
- Use explicit user type when provided (`bug`, `feature`, `task`).
- Otherwise infer type from intent:
  - `bug`: broken behavior, regression, error, failure.
  - `feature`: net-new capability or behavioral expansion.
  - `task`: maintenance, cleanup, docs, refactor, operational chore.
- Default to `task` when uncertain.

3. Build issue content from the type-specific template:
- Start from [references/issue-template.md](references/issue-template.md), then select one:
  - `bug`: [references/issue-template-bug.md](references/issue-template-bug.md)
  - `feature`: [references/issue-template-feature.md](references/issue-template-feature.md)
  - `task`: [references/issue-template-task.md](references/issue-template-task.md)
- Preserve explicit user wording for user-provided facts.
- Remove empty sections.

4. Enforce title/body usability limits:
- Title must be specific and scannable, with clear surface plus problem/outcome.
- Title hard max: 80 characters. Target range: 45-72 characters.
- If user-provided title exceeds 80 characters, rewrite concisely while preserving intent.
- Body caps:
  - Summary max 3 sentences.
  - Max 4 bullets per section.
  - One sentence per bullet.
  - `Unknowns` and `Hypotheses` max 3 bullets each.
  - Target issue body length: 450 words or fewer.

5. Research and verify before writing factual claims:
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
- Execute create/update/comment/labels as soon as required fields are available.
- Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.

7. Call GitHub API helper script:
- Use `scripts/gh_issue_api.mjs` for all issue API mutations.
- Before authenticated GitHub API calls in this turn, run:
  - `jr-rpc issue-credential github.issues.write`
- Then run normal `bash` commands; sandbox runtime applies scoped Authorization headers for this turn.
- Do not pass raw tokens into the sandbox.
- Required pattern:
  - `jr-rpc issue-credential github.issues.write`
  - `node /vercel/sandbox/skills/gh-issue/scripts/gh_issue_api.mjs ...`
- Read [references/github-issue-api.md](references/github-issue-api.md) for command shapes.
- Read [references/sandbox-runtime.md](references/sandbox-runtime.md) before relying on sandbox credentials.

8. Report result:
- Return canonical issue URL, issue number, issue type, applied changes, and confidence.
- Include references used for verified claims.

## Guardrails

- Never claim verification without citing sources.
- For `bug` issues, do not present a fix as definitive unless root cause evidence is explicit.
- Do not overwrite issue fields unless explicitly requested.
- Prefer partial updates over full body replacement.
- If repository or installation access is missing, stop and return a concrete remediation message.
