---
name: github-code
description: Work with GitHub repositories, source code, branches, commits, pushes, pull requests, reviews, diffs, and CI runs. Use for repo implementation tasks, source-code investigation, cloning/fetching, branch and push workflows, PR creation, PR updates, PR review feedback, and GitHub Actions checks. Prefer this skill for repository and code tasks even when the repo concerns Sentry products.
---

# GitHub Code Operations

Use `gh` and `git` for repository checkout, source investigation, code changes, commits, and pull request inspection or mutation. Use Junior's `github_createPullRequest` tool for new pull requests.

## References

| Need                                | Load                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Command syntax, permissions, config | [references/api-surface.md](references/api-surface.md)                                 |
| Failed commands, permission errors  | [references/troubleshooting-workarounds.md](references/troubleshooting-workarounds.md) |

## Core rules

- Resolve the target repo: explicit request wins, then `github.repo` config. Run `jr-rpc config get github.repo` standalone — never chain with `cd`, pipes, `gh`, or `git`.
- Keep `--repo owner/repo` explicit on all `gh` commands; use `git -C PATH` for local repos.
- Do not treat this skill's files or `/skills/...` as target repository source.
- Read repo-local instructions (`AGENTS.md`, `.github/AGENTS.md`, nested equivalents) before editing. When repo, task-specific, and skill instructions conflict, follow the narrower rule.
- Do not overwrite or revert unrelated user changes.
- Do not guess architecture, upstream intent, or feedback validity without reading the relevant code, comments, or failing output.
- Do not claim checks ran unless they did. Do not declare a fix complete without running the chosen check or stating why no credible check was available.
- Stop on: missing repo access, ambiguous target, destructive op without confirmation, or unresolved permission failure.

## Workflow

### 1. Resolve target and state

Identify `owner/repo`, local checkout path, default branch, and current branch.

For edit operations, also check:

- current branch and uncommitted changes
- package manager, build tool, monorepo structure
- relevant test/lint/typecheck commands
- repo-local instructions that override this skill

Choose a validation path before editing:

- changed-file or package-scoped checks before broad suites
- targeted tests before full runs
- repo-native scripts, fixtures, playgrounds, or smoke checks before one-off scaffolding

For risky, user-visible, or long-running changes, capture a baseline before editing. If the baseline already fails, record it as pre-existing.

Prefer existing local checkouts over cloning. Default to shallow clones.

### 2. Investigate before editing

Before changing code, establish:

- where the behavior lives
- what the current vs. requested behavior is
- root cause or gap the change addresses
- what smallest check can prove the result

Rules:

- Prefer narrow evidence: file reads, grep, tests, existing issues/PRs, command output.
- Read referenced issues, PRs, specs, policies, designs, or incidents when the task points to them.
- For product copy, docs, design, or UI work, inspect the real product/project context before inventing wording or layout.
- Before editing a bug, know the failure shape: what breaks, where, and under what condition.
- After a failed fix attempt or strong correction, stop patching symptoms — re-read the evidence and restate the root cause before editing again.
- If the task is investigation-only, answer from evidence without editing.

### 3. Edit safely

- Smallest coherent change that satisfies the request.
- Follow repo-local style, patterns, and API boundaries.
- Keep interfaces, exports, config, and public surfaces no broader than the requirement needs.
- When the change touches related call sites or representations, remove duplication or split logic introduced by the change before finalizing.
- No drive-by refactors or speculative cleanup.
- Do not optimize only for passing tests; solve the requested behavior.
- After meaningful edits, run the smallest relevant repo-real check.
- On check failure, inspect root cause before patching again.

For multi-step or risky work, keep a compact checklist of intent, touched files, verification state, next step, and blockers.

For non-obvious architecture, security-sensitive, concurrency, or repeated-failure work, pause after investigation with evidence, risks, and a proposed plan before pushing ahead.

### 4. Verify before packaging

Before committing and creating a PR for code, config, or docs-as-code changes:

- Run the chosen validation path. Separate pre-existing failures from regressions.
- For docs or instruction-only changes, do a content consistency review instead of claiming automated validation.
- If no credible check exists, say so explicitly.

### 5. Commit

Default format when the repo does not specify otherwise:

```
<type>(<scope>): <Subject>
```

Types: `feat`, `fix`, `ref`, `docs`, `test`, `build`, `ci`, `chore`. Imperative present tense, no trailing period, no agent/tool branding. Keep lines under 100 characters.

Body only when it helps reviewers understand _why_.

Footer order: `Fixes`/`Refs` lines.

### 6. Create or update PR

Before creating:

1. Changes committed on a non-default branch.
2. Push the branch explicitly: `git push -u origin BRANCH`.
3. Create with explicit targeting: `github_createPullRequest({ repo: "owner/repo", head: "BRANCH", base: "main", title: "...", body: "...", draft: true })`.

Defaults:

- Draft PRs unless the user or repo says otherwise.
- Reuse an existing PR for the branch; only open a new one when explicitly asked or the work is materially distinct.
- After new commits, re-evaluate title and body against the current diff.

**Title:** `<type>(<scope>): <Subject>` — same rules as commits, no agent branding.

**Body:**

- Reviewer-facing prose, not diff narration.
- What changed and why; what was verified; what remains unverified or risky.
- Issue references when relevant.
- No checkbox boilerplate, no PII or customer data in public repos.

**Footers** (in order):

1. Issue references (`Fixes #N`, `Refs SENTRY-N`), if any.

**Assignment:** resolve GitHub handles from evidence (`gh api search/users`, org membership, repo history) before assigning requested reviewers or assignees. Skip assignment when the handle cannot be confirmed.

### 7. Subscribe to PR lifecycle

After `github_createPullRequest` succeeds, check whether the result includes a subscribable resource hint. If it does, call `subscribeToResourceEvents` immediately before reporting.

- Use the suggested events from the hint; when absent, request review and CI events.
- Write a **self-contained intent** that captures repo, PR number, branch, and a single goal: resolve any review concerns and keep the build green. When an event fires, read the signal, address it, push, and report.
- **Only post an update when there is something meaningful to say.** Report when feedback has been addressed, a build failure has been fixed, the PR is fully green and ready to merge, or the PR has been merged. Stay silent on intermediate CI passes, queued checks, and informational events with no action taken.

If no subscribable hint is present, skip this step.

### 8. Report result

Return: repo, branch, PR URL/number (when applicable), checks run with results, pre-existing failures if any, checks not run and why.

On failure, report the exact command and error. Do not claim success from partial state.

Before finishing, reconcile any plan or checklist stated earlier — mark items as done, blocked, or cancelled.

## Operation-specific notes

**Clone** — shallow by default; deepen only when history is needed. Read repo instructions after cloning, before editing.

**Source investigation** — use local files first, otherwise clone shallowly or use `gh`. Cite evidence: file paths, symbols, PRs, issues, command output.

**PR inspection** — read-only `gh pr` and `gh api` commands. Query both conversation comments (`--json comments`) and review comments (`gh api .../pulls/{n}/comments` and `.../reviews`).

**PR mutation** — push before create. Retry once on permission failure after verifying repo targeting. Treat merge, close-with-delete, and force-push as confirmation-required. No admin mutations.

## Guardrails

- Default shallow clones; deepen only when needed.
- Confirm before destructive merges or force operations.
- Answer source questions from repo evidence, not product framing or memory.
- Stop and return concrete remediation on missing access or permissions.
