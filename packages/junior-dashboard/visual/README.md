# Dashboard visual CI

Deterministic screenshots for dashboard PRs. CI picks scenarios from the
changed-path rules in `scenarios.ts`, captures them with Playwright against the
built mock dashboard, and posts one sticky PR comment.

## Local

```sh
# capture scenarios for an explicit list
pnpm visual:dashboard -- --scenarios conversations,conversation-detail

# capture from a changed-file list (one path per line)
git diff --name-only origin/main...HEAD > /tmp/changed.txt
pnpm visual:dashboard -- --changed-file /tmp/changed.txt
```

Screenshots land in `.playwright/visual-dashboard/`.

## Adding a scenario

1. Add a route + ready heading to `VISUAL_SCENARIOS`.
2. Map owning source paths in `PATH_RULES`.
3. Keep the default selection under `MAX_VISUAL_SCENARIOS`.

This is evidence for reviewers, not a pixel-diff gate.
