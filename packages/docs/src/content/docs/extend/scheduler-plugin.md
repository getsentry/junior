---
title: Scheduler Plugin
description: Enable and verify Junior's scheduled task support.
type: tutorial
summary: Configure the scheduler plugin so Slack users can create reminders and recurring tasks.
prerequisites:
  - /start-here/quickstart/
  - /start-here/slack-app-setup/
related:
  - /reference/config-and-env/
  - /extend/build-a-plugin/
  - /operate/reliability-runbooks/
---

The scheduler plugin lives in `@sentry/junior-scheduler`. It registers Slack tools for creating, listing, updating, deleting, and running scheduled tasks, then uses Junior's internal heartbeat to dispatch due work back to the configured Slack conversation.

## Runtime setup

Install the package next to `@sentry/junior`:

```bash
pnpm add @sentry/junior-scheduler
```

Register the trusted plugin in app code:

```ts title="server.ts"
import { createApp } from "@sentry/junior";
import { schedulerPlugin } from "@sentry/junior-scheduler";

const app = await createApp({
  plugins: [schedulerPlugin()],
});

export default app;
```

List the package in `juniorNitro()` as well so Nitro bundles the manifest:

```ts title="nitro.config.ts"
juniorNitro({
  plugins: {
    packages: ["@sentry/junior-scheduler"],
  },
});
```

The scaffolded `vercel.json` includes the internal heartbeat route:

```json title="vercel.json"
{
  "crons": [
    {
      "path": "/api/internal/heartbeat",
      "schedule": "* * * * *"
    }
  ]
}
```

If you manage routes manually, call the heartbeat route on a one-minute cadence:

| Route                     | Purpose                         |
| ------------------------- | ------------------------------- |
| `/api/internal/heartbeat` | Runs trusted plugin heartbeats. |

## Configure environment variables

Set one heartbeat route secret:

| Variable                                   | Required   | Purpose                                                                            |
| ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| `CRON_SECRET` or `JUNIOR_SCHEDULER_SECRET` | Production | Bearer token for the internal heartbeat route. Use `CRON_SECRET` with Vercel Cron. |
| `JUNIOR_TIMEZONE`                          | No         | Default IANA timezone for schedule authoring. Defaults to `America/Los_Angeles`.   |

Local development can run without a heartbeat route secret when you call the dev server directly. Production deployments should set `CRON_SECRET` or `JUNIOR_SCHEDULER_SECRET`.

## Verify

Run the workflow in Slack where users will schedule work:

```text
remind me in 1 minute to stretch
```

Then confirm:

1. Junior acknowledges the scheduled task without asking for confirmation for the simple one-off reminder.
2. `what scheduled tasks do i have` lists the task in the same Slack conversation.
3. The reminder posts back to that conversation after the due time.

For recurring or non-reminder scheduled work, Junior should show the proposed task details and wait for confirmation before creating the task.

## Failure modes

- No due tasks run: confirm `/api/internal/heartbeat` is called every minute and the route secret matches the configured bearer token.
- Tasks list but never complete: check scheduler and dispatch logs for missing Slack destination fields or stale dispatch recovery errors.
- Unexpected timezone: set `JUNIOR_TIMEZONE` to the deployment default, or include the timezone in the user's schedule request.

## Next step

Read [Build a Plugin](/extend/build-a-plugin/) for the trusted `tools(ctx)` and `heartbeat(ctx)` APIs that the scheduler uses.
