# Contributing

Use this guide for local development in the `junior` monorepo.

## Requirements

- Node.js 20+
- pnpm
- Vercel CLI (`pnpm dlx vercel@latest`)
- Slack app credentials configured in Vercel
- Redis configured in Vercel (`REDIS_URL`)

## Local Setup

1. Install dependencies:

```bash
make
# or: make install
```

This runs `pnpm install` and `dotagents install`.

2. Link the repo to Vercel and pull development env vars:

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes --scope sentry
pnpm dlx vercel@latest env pull .env --environment=development --scope sentry
```

3. Start the app:

```bash
pnpm dev
```

## Development Commands

Run from repo root:

```bash
pnpm test
pnpm evals
pnpm typecheck
pnpm skills:check
pnpm docs:check
pnpm release:check
```

## Internal Documentation

- `policies/` contains durable repo-wide engineering rules.
- Package and module `README.md` files explain implemented architecture and
  non-obvious invariants near the code they describe.
- Code, schemas, exported types, and tests are the implementation authority.
- `openspec/changes/` contains temporary implementation plans. Move durable
  explanation beside the code and delete a plan when its work is complete.

Plans cannot override policies. Change the policy explicitly when the repository
intends to adopt a new default or exception.

## Worktree Helpers

Worktrees are development-only contributor tooling. Use the repo helper when
starting isolated branch work, especially when a coding agent such as Codex
should work without taking over your main checkout:

```bash
pnpm worktree new codex/my-task --agent "codex"
pnpm worktree new review/pr-123 --open "code ."
pnpm worktree list
pnpm worktree exec codex/my-task -- pnpm typecheck
pnpm worktree remove codex/my-task
```

Codex app worktrees are separate from the repo helper. When you choose
**Worktree** in Codex, Codex creates managed, disposable worktrees under
`$CODEX_HOME/worktrees`; do not point `JUNIOR_WORKTREE_DIR` there or rely on
that directory for long-lived branch work. Use the repo helper when you want a
named local worktree you can keep, inspect, and remove yourself.

Make sure Codex trusts the main checkout before starting agent work. In Codex,
trust the project from the app prompt, or add the checkout to
`~/.codex/config.toml`:

```toml
[projects."/absolute/path/to/junior"]
trust_level = "trusted"
```

If you create a long-lived helper worktree and open it as its own Codex project,
trust that worktree path too. Shared repo instructions stay in `AGENTS.md`;
personal Codex defaults such as model, sandbox, approvals, and MCP servers stay
in `~/.codex/config.toml` or your personal `.codex/config.toml` layers, not in
these dev-only helper files.

New worktrees are created under `../junior-worktrees` by default, copy matching
local files from the primary checkout using `scripts/worktree.include`, and run
`pnpm install`. The copied files include env files and Vercel project links, so
fresh worktrees can run `pnpm dev`, `pnpm dev:env`, and focused checks without
relinking every time. `pnpm worktree list` marks the checkout running the helper
with `*`. Set `JUNIOR_WORKTREE_DIR`, `JUNIOR_WORKTREE_BASE`, or pass `--path`,
`--from`, `--source`, or `--no-install` to override those defaults. Set
`JUNIOR_WORKTREE_SOURCE` to change the checkout copied into new worktrees and
`setup` runs. Relative `JUNIOR_WORKTREE_DIR` values resolve from the primary
checkout root. `--from` and `JUNIOR_WORKTREE_BASE` only apply when creating a
new branch; existing branches open at their current tip.

Build and validate the published package artifacts:

```bash
pnpm build:pkg
```

## Releasing

This repo uses Craft for manual lockstep npm releases of:

- `@sentry/junior`
- `@sentry/junior-plugin-api`
- `@sentry/junior-agent-browser`
- `@sentry/junior-amplitude`
- `@sentry/junior-cloudflare`
- `@sentry/junior-dashboard`
- `@sentry/junior-datadog`
- `@sentry/junior-github`
- `@sentry/junior-hex`
- `@sentry/junior-linear`
- `@sentry/junior-maintenance`
- `@sentry/junior-memory`
- `@sentry/junior-notion`
- `@sentry/junior-scheduler`
- `@sentry/junior-sentry`
- `@sentry/junior-vercel`

Run `pnpm release:check` before changing release package lists so `.craft.yml`, CI,
the bump script, and the release docs stay aligned.

Trigger releases from GitHub Actions:

1. Open `Actions` -> `Release`.
2. Run workflow with `bump` (`patch`, `minor`, or `major`).
3. Set `force=true` only when intentionally bypassing release blockers.

Required repository/org configuration:

- Variable: `SENTRY_RELEASE_BOT_CLIENT_ID`
- Secret: `SENTRY_RELEASE_BOT_PRIVATE_KEY`
- npm publish credentials available to Craft/action-prepare-release runtime.

## File-Scoped Tests

Run a single unit test file:

```bash
pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts
```

Run a single eval file:

```bash
pnpm --filter @sentry/junior-evals evals path/to/eval.test.ts
```

## Evals

Use evals for end-to-end behavior testing of Junior's reply pipeline (prompting, tools, and expected outputs). Evals do not test live Slack transport.

See `policies/testing.md`, `packages/junior/tests/README.md`, and
`packages/junior-evals/README.md` for authoring details.

## Slack Tunnel (Cloudflare)

Install `cloudflared` first (`brew install cloudflared` on macOS).

`pnpm dev` serves the example app on `http://localhost:3000` by default. The
bundled Cloudflare tunnel helper targets the same port unless
`CLOUDFLARE_TUNNEL_URL` overrides it.

Quick tunnel with a random hostname:

```bash
cloudflared tunnel --url http://localhost:3000
```

Stable hostname setup:

```bash
cloudflared tunnel login
cloudflared tunnel create junior-dev
cloudflared tunnel route dns junior-dev junior-dev.sentry.cool
```

Add the named tunnel token to `.env.local`:

```bash
pnpm cloudflare:token
```

Run `pnpm cloudflare:token` again after `vercel env pull` whenever it rewrites `.env.local`.

Run local dev with the stable tunnel:

```bash
pnpm dev
```

Set Slack Event Subscriptions and Interactivity request URL to:

```text
https://junior-dev.sentry.cool/api/webhooks/slack
```
