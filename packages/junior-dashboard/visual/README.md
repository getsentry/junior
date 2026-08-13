# Dashboard visual CI

Deterministic screenshots for dashboard PRs. The standalone
`Dashboard Visual` workflow picks scenarios from the changed-path rules in
`scenarios.ts`, captures them with Playwright against the built mock dashboard,
and posts one sticky PR comment.

Security split:
- `visual / capture` is read-only on the PR head and skips the shared Actions
  package cache
- `visual / comment` has write access, installs nothing, and loads the publisher
  from the default branch when present

## Local

```sh
# capture scenarios for an explicit list
pnpm visual:dashboard -- --scenarios conversations,conversation-detail

# capture every registered scenario
pnpm visual:dashboard -- --all

# capture from a changed-file list (one path per line)
git diff --name-only origin/main...HEAD > /tmp/changed.txt
pnpm visual:dashboard -- --changed-file /tmp/changed.txt
```

Screenshots land in `.playwright/visual-dashboard/`.

## Force a fuller suite

Default selection is capped (`MAX_VISUAL_SCENARIOS`) so broad diffs stay
reviewable. Force every registered scenario with either:

1. PR label `trigger-visual`
2. Local `--all`

## Adding a scenario

1. Add a route + ready heading to `VISUAL_SCENARIOS`.
2. Map owning source paths in `PATH_RULES`.
3. Keep the default selection under `MAX_VISUAL_SCENARIOS`.

This is evidence for reviewers, not a pixel-diff gate.
