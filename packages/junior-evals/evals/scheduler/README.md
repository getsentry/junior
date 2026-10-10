# Scheduler Evals

Hard-fail scheduler system contracts and their helpers live under `evals/integration/scheduler/`:

- creating clear one-off and recurring schedules without confirmation
- preserving executable future work in scheduled automation text
- omitting success notifications for clearly scoped maintenance requests
- creator vs system credential mode
- rescheduling existing tasks
- delivering a due reminder to its creator
- finishing a due automation with no message outcome without a post
- answering a person's reply to a delivered reminder as a normal chat reply

The notification-default case asks for nightly fix PRs without asking for
silence. The broader "fix failing CI" request lives in Guardian's
`scheduled-work.eval.ts`: a reviewable PR workflow is allowed, while unreviewed
default-branch pushes require confirmation. This separates notification defaults
from write authorization.

This folder keeps behavioral due-occurrence delivery quality:

- delivering due one-off and recurring scheduled automation occurrences
- addressing the known task creator without a name lookup
- delivering a reminder in the creator's direct message as the reminder itself
- reminders that mention nobody when the task names nobody
- ending a run that cannot work as `misconfigured`, without a post

## Automation run failures

Each failure seen in production has one realistic case:

- Reminders sent to a direct message read as failure notes or third-person
  text (#2014): the direct message case in `delivery.eval.ts`.
- Reminders mention people that the task does not name (#554): the channel
  reminder cases in `delivery.eval.ts`.
- Status reports instead of the deliverable (#2014): the rubrics of the
  reminder cases, and the no-outcome case in
  `evals/integration/scheduler/delivery.eval.ts`.
- "me" does not reach the creator (#2014): the creator mention case in
  `evals/integration/scheduler/delivery.eval.ts`.
- Unattended runs ask questions, or post when a condition is not met, and the
  silence marker leaks into Slack (#2014, #1741): the condition cases in
  `evals/integration/coding/event-automations/delivery.eval.ts`.
- Runs find missing credentials and ask the channel to connect them (#2014):
  the missing account case in `evals/sentry/skills.eval.ts`.
- A run that cannot work ends in silence and runs again on the next event:
  the blocked case in
  `evals/integration/coding/event-automations/delivery.eval.ts`. The
  automation becomes blocked, and only its creator gets the notice.

Run the suites with:

```bash
pnpm --filter @sentry/junior-evals evals:integration evals/integration/scheduler
pnpm --filter @sentry/junior-evals evals:behavioral evals/scheduler
```
