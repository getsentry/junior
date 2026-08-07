# Scheduler Evals

Hard-fail scheduler system contracts and their helpers live under `evals/integration/scheduler/`:

- creating clear one-off and recurring schedules without confirmation
- preserving executable future work in scheduled task text
- creator vs system credential mode
- rescheduling existing tasks

This folder keeps behavioral due-occurrence delivery quality and its delivery-only helpers:

- delivering due one-off and recurring scheduled task occurrences

Run the suites with:

```bash
pnpm --filter @sentry/junior-evals evals:integration evals/integration/scheduler
pnpm --filter @sentry/junior-evals evals:behavioral evals/scheduler
```
