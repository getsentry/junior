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
`design/prompts.md` and `policies/` before you propose a change.

Junior checks each new pull request, including drafts. If a larger change has
no linked issue, Junior closes the pull request and explains why. Open an
issue, then open a new pull request that links it, or ask a maintainer to
reopen the old one. Users with the `maintain` or `admin` role are exempt.

## Local Setup

You need Node.js 24, pnpm 10 or later, Docker, the Vercel CLI
(`pnpm dlx vercel@latest`), and access to the Sentry Vercel team. pnpm
switches to the version that `packageManager` in `package.json` pins.

```bash
make   # pnpm install + pnpm build + dotagents install
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes --scope sentry
pnpm dlx vercel@latest env pull .env --environment=development --scope sentry
pnpm dev
```

[Development](packages/docs/src/content/docs/contribute/development.md)
explains what `pnpm dev` starts, how to run checks, local Docker sandboxes,
dashboard mock data, Slack tunnels, and the `pnpm worktree` helper. Sentry
staff use `junior-dev.sentry.cool` as the stable tunnel hostname.

## Documentation

Write docs in ASD-STE100 English and use the words in `TERMINOLOGY.md`.

- Internal docs: follow `policies/documentation.md`.
- Public docs: follow `contribute/documentation-guidelines.md` and the `public-docs`
  skill.

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
- `@sentry/junior-notion`
- `@sentry/junior-octolens`
- `@sentry/junior-pagerduty`
- `@sentry/junior-restream`
- `@sentry/junior-sentry`
- `@sentry/junior-vercel`
- `@sentry/junior-vimeo`
- `@sentry/junior-xdotcom`

Run `pnpm release:check` after you change this list. It keeps CI, the bump
script, and the release docs aligned. Craft publishes every public workspace
package, so `.craft.yml` has no package list.

[Releasing](packages/docs/src/content/docs/contribute/releasing.md) has the
release steps and the required repository configuration.
