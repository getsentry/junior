---
name: github-code
description: Clone GitHub repositories, investigate source code, and manage pull requests via GitHub CLI. Use when users ask to inspect implementation details in a repository, clone code, edit files, answer source-code questions from repo evidence, or open/edit/view/merge pull requests. Prefer this skill for repository and code tasks even when the repo concerns Sentry products.
uses-config: github.repo
allowed-tools: bash
---

# GitHub Code Operations

Repository checkout, source-code investigation, and pull request operations via `gh` CLI.

## Reference loading

| Operation     | Load                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| Any operation | [references/api-surface.md](references/api-surface.md)                                 |
| On failure    | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Workflow

### 1. Resolve operation and target

- Determine whether the task is `clone`, `source-code investigation`, a pull request inspection (`view`, `list`, `diff`, `checks`), or a pull request mutation (`create`, `update`, `close`, `merge`).
- Resolve repository (`owner/repo`). If not explicit, query channel config with `jr-rpc config get github.repo` before running any `gh` or `git` command. If still missing, ask the user.
- Resolve the pull request number for operations targeting an existing PR.
- Keep `--repo owner/repo` explicit on `gh` commands so the command itself targets the intended repository, not a stale default.

### 2. Execute by operation type

**Clone** → shallow clone path below.
**Source-code investigation** → source-code path below.
**Pull request inspection** → inspection path below.
**Pull request mutation** → mutation path below.

---

### Clone path

- Default to a shallow clone; deepen incrementally only when the task needs history.
- Use exact command forms from [references/api-surface.md](references/api-surface.md).
- After cloning, check for `AGENTS.md` in the repo root (and `.github/AGENTS.md`) before making edits. Treat discovered instructions as hard constraints.
- Report the local directory and whether the clone is shallow or full.

---

### Source-code investigation path

- Use for questions like "where is this implemented?", "how does this workflow work in code?", "is there already logic for X?", or "verify this from the repo."
- If the current workspace already contains the target repository, inspect local files directly before cloning.
- Prefer the narrowest deterministic evidence: local file search, exact file reads, targeted clone inspection, existing issues/PRs, tests.
- Cite repository evidence in the reply: file paths, symbols, issue/PR numbers, or commit references when known.
- If evidence is incomplete, say what is unknown instead of guessing.

---

### Pull request inspection path

- Use read-only `gh pr` commands from [references/api-surface.md](references/api-surface.md); skip branch resolution and push logic.
- Return canonical PR URL, PR number when available, target repository, and the fields the user asked to inspect.
- If the PR cannot be resolved, report the exact not-found or auth failure and stop.

---

### Pull request mutation path

#### 3. Resolve mutation inputs

- For PR creation, resolve the base branch (explicit user request wins; otherwise repository default).
- Resolve the head branch from the current checkout or user request.
- If the head branch may not exist on the remote yet, push it explicitly before PR creation.

#### 4. Execute

- Run `git push` first so `gh pr create` does not trigger hidden push/fork behavior; then `gh pr create --repo owner/repo --head BRANCH ...`.
- If `git push` returns 401/403 or another auth/permission error, verify the command is targeting the right repository and retry once. If it still clearly indicates bad or revoked credentials, rerun the real GitHub command and let the runtime trigger a reconnect flow.
- Treat `gh pr merge` as a contents mutation and keep repository context explicit.

#### 5. Report result

- Return canonical PR URL, PR number when available, target repository, and applied changes.
- If PR creation fails after explicit push + explicit repo scoping, report the exact auth or validation failure and stop.

## Guardrails

- Require explicit confirmation only for destructive merges or force operations.
- Answer source-code questions from repository evidence, not product framing or generic memory.
- Default to shallow clones; do not use a full clone unless the task requires repository history or the user asks for it.
- If repository or installation access is missing, stop and return a concrete remediation message.
- Do not execute repository admin mutations.
