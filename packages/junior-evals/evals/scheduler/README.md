# Scheduler Evals

Scheduler evals cover agent-facing scheduled task behavior:

- creating clear one-off reminders without confirmation
- preserving executable future work in scheduled task text
- creating clear recurring work without confirmation
- enabling creator credentials only after explicit authorization
- asking before ambiguous scheduled credential delegation
- keeping explicit denial and non-creator requests in system mode
- delivering due one-off and recurring scheduled task occurrences

Run this module with:

```bash
pnpm --filter @sentry/junior-evals evals evals/scheduler/workflows.eval.ts
```
