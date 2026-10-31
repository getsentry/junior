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

Before the app starts, `pnpm dev` runs `docker compose up -d --wait`. This starts Postgres, Redis and S3 from `compose.yaml` and waits until they are healthy. Docker must be running. Services that already run are left as they are. Then `pnpm dev` runs `junior upgrade` to apply missing database migrations to `DATABASE_URL`. Migrations that already ran are skipped. If either step fails, `pnpm dev` stops.

`pnpm dev` delivers background work through BullMQ on the Redis in `compose.yaml` (`redis://localhost:6382`), which `pnpm dev` starts. Local work then needs no Vercel Queues access. To use Vercel Queues, set `JUNIOR_QUEUE_PROVIDER=vercel` and run `pnpm dev:env` for the Vercel token. To use another Redis, set `JUNIOR_QUEUE_REDIS_URL`.

With BullMQ, `pnpm dev` starts one queue worker process next to Nitro. Nitro accepts requests and sends jobs. The worker runs them. A new Junior build restarts both processes. A change to `apps/example/server.ts`, `plugins.ts`, `dashboard.ts` or `apps/example/app/` restarts only the worker. The worker and Nitro must share state, so `pnpm dev` keeps state in that Redis unless you set `JUNIOR_STATE_ADAPTER`. `JUNIOR_STATE_ADAPTER=memory` does not work with BullMQ. Each queue topic runs up to 4 jobs at the same time. Set `JUNIOR_QUEUE_WORKER_CONCURRENCY` to change that number.

To also open the Sentry Local UI in your browser, set `OPEN_SPOTLIGHT_WEB=1`:

```bash
OPEN_SPOTLIGHT_WEB=1 pnpm dev
```

For dashboard visual QA without generating real Slack traffic, replace conversation API responses with sample fixtures:

```bash
JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev
```

The fixtures are read-only dashboard data; mock mode does not query or merge real conversation records.

## Run sandboxes in local Docker

By default, Junior runs agent sandboxes in Vercel Sandbox. To run them in a local Docker daemon instead, set the provider in `.env`:

```bash
JUNIOR_SANDBOX_PROVIDER=docker
```

The Docker provider needs a Docker daemon on a unix socket. It uses `/var/run/docker.sock`, or the unix socket in `DOCKER_HOST`. On macOS, the daemon runs in a VM, so each sandbox sends its web traffic through an egress relay container. Each sandbox is a privileged container, so do not run untrusted workloads with it.

The first sandbox builds the `junior-sandbox-runtime` image. This takes a few minutes. Later sandboxes start in seconds. `pnpm dev` and `pnpm cli -- chat ...` both use the provider. Each process runs its own egress proxy, and the process that last acquired a sandbox carries its web traffic.

Docker sandboxes have a small toolset: `gh`, `jq`, and `ripgrep`. They do not include other plugin CLIs, browsers, or Docker. The agent installs other tools with `sudo` when it needs them. Vercel sandboxes still include every tool that the plugins declare.

Optional settings:

- `JUNIOR_DOCKER_SANDBOX_DIR` sets the directory of the local egress CA. The default is `~/.cache/junior/docker-sandbox`.
- `JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS` names a PEM file that each sandbox also trusts. Set it when your machine is behind a TLS proxy.

To remove all Docker sandboxes and snapshots:

```bash
docker rm -f -v $(docker ps -aq --filter label=dev.junior.sandbox)
docker network prune -f --filter label=dev.junior.sandbox
docker image prune -a -f --filter label=dev.junior.sandbox=snapshot
```

The limits of this provider are in `packages/junior/src/chat/sandbox/README.md`.

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
