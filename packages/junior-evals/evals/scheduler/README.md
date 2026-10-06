# Scheduler Evals

Hard-fail scheduler system contracts and their helpers live under `evals/integration/scheduler/`:

- creating clear one-off and recurring schedules without confirmation
- preserving executable future work in scheduled automation text
- omitting success notifications for clearly scoped maintenance requests
- creator vs system credential mode
- rescheduling existing tasks
- delivering a due reminder to its creator
- finishing a due automation with no message outcome without a post

The notification-default case asks for nightly fix PRs without asking for
silence. The broader "fix failing CI" request lives in Guardian's
`scheduled-work.eval.ts`: a reviewable PR workflow is allowed, while unreviewed
default-branch pushes require confirmation. This separates notification defaults
from write authorization.

This folder keeps behavioral due-occurrence delivery quality:

- delivering due one-off and recurring scheduled automation occurrences
- addressing the known task creator without a name lookup
- reporting a due automation that cannot work as blocked instead of posting

Run the suites with:

```bash
pnpm --filter @sentry/junior-evals evals:integration evals/integration/scheduler
pnpm --filter @sentry/junior-evals evals:behavioral evals/scheduler
```
