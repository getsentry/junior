# Dashboard visual CI

Deterministic screenshots for dashboard PRs. Two workflows own the path:

1. `Dashboard Visual` (`.github/workflows/dashboard-visual.yml`) captures on the
   PR head with a read-only token and uploads artifacts
2. `Dashboard Visual Comment` (`.github/workflows/dashboard-visual-comment.yml`)
   runs from the default branch via `workflow_run`, downloads those artifacts,
   and posts one sticky PR comment with the trusted publisher

Capture never gets write access. Comment never installs packages and never
checks out PR head.

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
4. Prefer a stable page/section heading as `ready` (for example `System`,
   `Baseline snapshot`). Do not wait on chart titles or stat labels.
5. For interaction shots (focus, open menu), set `prepare` and implement the
   steps in `capture.ts`. Keep the registry data-only.

`conversation-create-focused` is the mobile create-mode keyboard shot: open
create, focus the composer, shrink `visualViewport`, then capture the viewport.

This is evidence for reviewers, not a pixel-diff gate.
