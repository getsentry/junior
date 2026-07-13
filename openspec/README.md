# Implementation Plans

`openspec/changes/<slug>/` contains temporary plans for work that is not yet
fully implemented.

Plans may include a proposal, design notes, and a task checklist. They describe
the intended change and verification strategy; they are never the canonical
description of current behavior and cannot override `../policies/`.

## Lifecycle

1. Create a plan when a change spans multiple boundaries or needs an explicit
   rollout sequence.
2. Implement against the owning code, policies, and module documentation.
3. Move any durable explanation into code, types, tests, or the owning
   `README.md`.
4. Delete the completed plan.

Do not archive completed trackers by default. Git history is the archive. Keep
historical design material only when it explains a lasting decision that cannot
be recovered from the resulting implementation.
