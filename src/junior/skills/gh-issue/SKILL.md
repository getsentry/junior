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

2. Build issue content from the template:
- Start from [references/issue-template.md](references/issue-template.md).
- Keep sections concise and remove empty sections.
- Preserve explicit user wording for user-provided facts.

3. Research and verify before writing factual claims:
- Follow [references/research-rules.md](references/research-rules.md).
- Prefer first-party evidence (repo code, issues, docs, changelogs).
- Mark uncertain statements as unknown instead of presenting guesses as facts.
- For writing quality and structure, use [references/issue-examples.md](references/issue-examples.md).

4. Mutate by default (no preview gate):
- Execute create/update/comment/labels as soon as required fields are available.
- Do not pause for confirmation unless the user explicitly asks for preview/dry-run.
- Require explicit confirmation only for close/reopen or destructive broad rewrites.

5. Call GitHub API helper script:
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

6. Report result:
- Return canonical issue URL, issue number, applied changes, and confidence.
- Include references used for verified claims.

## Guardrails

- Never claim verification without citing sources.
- Do not overwrite issue fields unless explicitly requested.
- Prefer partial updates over full body replacement.
- If repository or installation access is missing, stop and return a concrete remediation message.
