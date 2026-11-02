# Contributing

This guide explains how to propose changes to the `junior` monorepo and run it
locally. Full contributor docs are in
`packages/docs/src/content/docs/contribute/` (published at
`junior.sentry.dev`).

## Open an Issue Before Larger Changes

Before you open a pull request for a larger change, open a GitHub issue. State
the problem and your approach. Link the issue from the pull request, for
example with `Fixes #123`.

Larger changes are:

- new features or changes to existing behavior
- architecture, plugin API, configuration, or extension point changes
- broad refactors
- prompt, tool description, or skill changes that try to fix agent behavior,
  even when the diff is small

Small changes need no issue: a focused bug fix, a small docs fix, a test-only
fix, or a dependency update.

The issue lets maintainers find architecture problems before you write code.
For agent behavior, a prompt change often hides the real cause. Read
`policies/` (start with `policies/agent-steering.md`) before you propose a
change.

Junior checks each new pull request, including drafts. If a larger change has
no linked issue, Junior closes the pull request and explains why. Open an
issue, then open a new pull request that links it, or ask a maintainer to
reopen the old one. Users with the `maintain` or `admin` role are exempt.

## Local Setup

You need Node.js 24, pnpm, Docker, the Vercel CLI
(`pnpm dlx vercel@latest`), and access to the Sentry Vercel team.

```bash
make   # pnpm install + dotagents install
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes --scope sentry
pnpm dlx vercel@latest env pull .env --environment=development --scope sentry
pnpm dev
```

`contribute/development.md` explains what `pnpm dev` starts, local Docker sandboxes,
dashboard mock data, and the `pnpm worktree` helper for isolated branches.

## Checks

Run from the repo root:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm skills:check
pnpm docs:check
pnpm release:check
pnpm build && pnpm package-types:check
```

`AGENTS.md` lists file-scoped test and eval commands. `contribute/testing.md` and
`policies/testing.md` say which test layer to use.

## Documentation

Write docs in ASD-STE100 English and use the words in `TERMINOLOGY.md`.

- Internal docs: follow `policies/documentation.md`.
- Public docs: follow `contribute/documentation-guidelines.md` and the `public-docs`
  skill.
- `openspec/changes/` holds temporary plans. Plans cannot override policy.
  Delete a plan when its work is complete.

## Slack Tunnel

Install `cloudflared` (`brew install cloudflared`). For a random hostname, run
`cloudflared tunnel --url http://localhost:3000`.

For a stable hostname:

```bash
cloudflared tunnel login
cloudflared tunnel create junior-dev
cloudflared tunnel route dns junior-dev junior-dev.sentry.cool
pnpm cloudflare:token   # writes the tunnel token to .env.local
pnpm dev
```

Run `pnpm cloudflare:token` again after `vercel env pull` rewrites
`.env.local`. Set `CLOUDFLARE_TUNNEL_URL` to use a port other than 3000.

Set the Slack Event Subscriptions and Interactivity request URL to
`https://junior-dev.sentry.cool/api/webhooks/slack`.

## Releasing

This repo uses Craft for manual lockstep npm releases of:

- `@sentry/junior`
- `@sentry/junior-plugin-api`
- `@sentry/junior-agent-browser`
- `@sentry/junior-amplitude`
- `@sentry/junior-cloudflare`
- `@sentry/junior-dashboard`
- `@sentry/junior-datadog`
- `@sentry/junior-figma`
- `@sentry/junior-tts`
- `@sentry/junior-github`
- `@sentry/junior-google`
- `@sentry/junior-hex`
- `@sentry/junior-linear`
- `@sentry/junior-maintenance`
- `@sentry/junior-memory`
- `@sentry/junior-notion`
- `@sentry/junior-octolens`
- `@sentry/junior-pagerduty`
- `@sentry/junior-sentry`
- `@sentry/junior-vercel`

Run `pnpm release:check` after you change this list. It keeps `.craft.yml`,
CI, the bump script, and the release docs aligned.

To release, open **Actions → Release** and run it with a `bump` (`patch`,
`minor`, or `major`). Set `force=true` only to bypass release blockers on
purpose. `contribute/releasing.md` has the full process and the required repository
configuration.
