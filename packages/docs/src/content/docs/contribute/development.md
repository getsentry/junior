---
title: Development
description: Local development workflow for the Junior monorepo.
type: tutorial
summary: Set up Junior locally, run checks, and use isolated worktrees for parallel agent or contributor tasks.
prerequisites: []
related:
  - /contribute/testing/
  - /contribute/releasing/
  - /start-here/quickstart/
---

## Prerequisites

- Node.js 24
- pnpm
- Vercel CLI
- Slack app credentials
- Redis configured for development

## Setup

```bash
pnpm install
```

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes
pnpm dlx vercel@latest env pull .env --environment=development
```

If your team account requires an explicit Vercel scope, add `--scope <team-slug>` to the `link` and `env pull` commands.

## Run

```bash
pnpm dev
```

This starts the example app on `http://localhost:3000` by default. It also rebuilds and watches the workspace packages that the example app consumes, so dashboard and runtime package edits are reflected without manually rebuilding first.

For dashboard visual QA without generating real Slack traffic, replace conversation API responses with sample fixtures:

```bash
JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev
```

The fixtures are read-only dashboard data; mock mode does not query or merge real conversation records.

## Work in isolated branches

Worktrees are development-only contributor tooling. Use them when you want to keep your main checkout stable while reviewing a PR, testing a fix, or running a coding agent such as Codex on a task. The repo helper creates the Git worktree, copies local development files, and installs dependencies in the new checkout.

```bash
pnpm worktree new codex/fix-slack-retry --agent "codex"
```

Use `--open "code ."` instead of `--agent "codex"` when you want to open the worktree in an editor first:

```bash
pnpm worktree new review/pr-123 --open "code ."
```

New worktrees are created under `../junior-worktrees` by default. They start from `origin/main` when available, then copy matching local files from the primary checkout using `scripts/worktree.include`, including env files and Vercel project links.

Codex app worktrees are separate from this repo helper. When you choose **Worktree** in Codex, Codex creates managed, disposable worktrees under `$CODEX_HOME/worktrees`; do not point `JUNIOR_WORKTREE_DIR` there or rely on that directory for long-lived branch work. Use the repo helper when you want a named local worktree you can keep, inspect, and remove yourself.

Make sure Codex trusts the main checkout before starting agent work. In Codex, trust the project from the app prompt, or add the checkout to `~/.codex/config.toml`:

```toml
[projects."/absolute/path/to/junior"]
trust_level = "trusted"
```

If you create a long-lived helper worktree and open it as its own Codex project, trust that worktree path too. Shared repo instructions stay in `AGENTS.md`; personal Codex defaults such as model, sandbox, approvals, and MCP servers stay in `~/.codex/config.toml` or your personal `.codex/config.toml` layers, not in these dev-only helper files.

Run commands inside a worktree without changing directories:

```bash
pnpm worktree exec codex/fix-slack-retry -- pnpm typecheck
```

List active worktrees before switching contexts. The checkout running the helper is marked with `*`:

```bash
pnpm worktree list
```

After the branch is merged or no longer needed, remove the clean worktree:

```bash
pnpm worktree remove codex/fix-slack-retry
```

Set `JUNIOR_WORKTREE_DIR` to change the parent directory, set `JUNIOR_WORKTREE_BASE` to change the default base ref, set `JUNIOR_WORKTREE_SOURCE` to change the checkout copied into new worktrees and `setup` runs, or pass `--path`, `--from`, `--source`, or `--no-install` for one-off overrides. Relative `JUNIOR_WORKTREE_DIR` values resolve from the primary checkout root. `--from` and `JUNIOR_WORKTREE_BASE` only apply when creating a new branch; existing branches open at their current tip.

## Common checks

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm skills:check
pnpm docs:check
```

## Slack tunnel

```bash
cloudflared tunnel --url http://localhost:3000
```

Set Event Subscriptions and Interactivity URL to:

```text
https://<tunnel-host>/api/webhooks/slack
```

## Next step

Run focused checks from [Testing](/contribute/testing/), then verify behavior in [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/).
