# Scheduler Evals

Scheduler evals cover agent-facing scheduled task behavior:

- creating clear one-off reminders without confirmation
- emitting structured schedule intent while the scheduler owns exact timestamps
- preserving executable future work in scheduled task text
- creating clear recurring work without confirmation
- making creator credentials available when scheduled work may need user-bound
  authorization
- keeping explicit denial and non-creator requests in system mode, while the
  creator can later restore credential availability
- executing creator-bound Sentry work with the creator's connected account
  without an extra authorization prompt
- delivering due one-off and recurring scheduled task occurrences

Run this feature area with:

```bash
pnpm --filter @sentry/junior-evals evals evals/scheduler
```
