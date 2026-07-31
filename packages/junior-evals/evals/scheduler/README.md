# Scheduler Evals

Scheduler evals cover agent-facing scheduled task behavior:

- creating clear one-off reminders without confirmation
- emitting structured schedule intent while the scheduler owns exact timestamps
- preserving executable future work in scheduled task text
- creating clear recurring work without confirmation
- making creator credentials available when scheduled work may need user-bound
  authorization
- keeping explicit denial and non-creator requests in system mode
- delivering due one-off and recurring scheduled task occurrences

Run this feature area with:

```bash
pnpm --filter @sentry/junior-evals evals evals/scheduler
```
