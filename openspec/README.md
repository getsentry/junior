# Implementation Plans

- `openspec/changes/<slug>/` holds temporary plans for work that is not done.
- A plan states the intended change and how to verify it. It never describes
  current behavior and cannot override `../policies/`.
- Write a plan only when a change crosses many boundaries or needs a rollout
  order.
- When the work is done, move lasting rules into code, types, tests, or the
  owning `AGENTS.md`. Then delete the plan. Git history is the archive.
