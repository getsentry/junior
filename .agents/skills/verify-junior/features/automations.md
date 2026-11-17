# Automations

A user saves an instruction or a skill, and Junior runs it later: on a Schedule, on a matching Event, or on a new message in a Slack channel. Each Automation run posts to the Destination where the user created the Automation. Intent and rules: `design/automations.md`.

## Claims

- `create-scheduled` A user asks for a reminder or a recurring task. Junior saves it without a confirmation step, and posts the reminder itself when it is due. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:integration evals/integration/scheduler/creation.eval.ts -t "when asked for a simple one-off reminder, create it without asking for confirmation|when asked to schedule clear recurring work, create it in the active channel"`, and `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/scheduler/delivery.eval.ts -t "when a one-off reminder becomes due, deliver the reminder outcome|when a recurring scheduled automation becomes due, deliver that occurrence"`.
- `create-event` A user asks Junior to act when a resource changes. Junior saves one Event automation, and each matching Event starts one Automation run. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:integration evals/integration/coding/event-automations/management.eval.ts -t "when a resource supports the requested event, create the requested event automation"`, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/event-automations.test.ts -t "fans one event out to every matching task and deduplicates retries"`.
- `channel-message` A user asks Junior to act on new posts in a channel. Junior replies in the thread of each new top-level message in that channel. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/slack/channel-message-automations.test.ts -t "runs for new top-level messages in its own channel and replies in their threads"`.
- `manage` A user asks to list, reschedule, pause, resume, or delete. Junior changes the existing Automation and does not create a new one. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:integration evals/integration/scheduler/management.eval.ts evals/integration/coding/event-automations/management.eval.ts -t "when asked to reschedule an existing task, replace its cadence|when managing an existing event automation, list update and delete it|when asked to pause and then resume an event automation, change its status"`.
- `move` A user asks, in a different conversation, to move an Automation there. Its later runs post to that conversation. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:integration evals/integration/scheduler/move.eval.ts -t "when asked once in the destination channel, update the requester task to deliver here"`.
- `run-now` A user asks to run a Scheduled automation now. It runs soon, and its Schedule does not change. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/scheduled-automation-tools.test.ts -t "marks an active task due immediately without changing its scheduled next run|does not run-now a blocked task"`. See Gaps for the agent half.
- `no-action` The instruction's condition is not met. The Automation run posts nothing. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:integration evals/integration/coding/event-automations/delivery.eval.ts -t "when the task condition does not match the event, post nothing"`.
- `blocked` An Automation run cannot work. Junior blocks the Automation and tells only its creator, in a DM. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/event-automation-blocking.test.ts -t "blocks an event automation after a blocked run and tells its creator once"`, and `eval` with `pnpm --filter @sentry/junior-evals evals:integration evals/integration/coding/event-automations/delivery.eval.ts -t "when an event automation cannot work, block it and tell only its creator"`.
- `dashboard` A user opens an Automation in the dashboard. The user sees its runs and versions, and can edit, pause, resume, or delete it, or make an earlier version active. Proof: `drive` for the runs, `test` with `pnpm test:e2e:dashboard --grep "opens one automation's runs|edits an Automation in place|pauses and resumes from the Automation page|deletes the Automation|makes an earlier version active from version history"` for the other actions, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/api/automation-lifecycle.test.ts tests/integration/api/automations.test.ts -t "resumes future schedule times without restarting completed work|lists owned and public automations and denies private deletes"` for the server half.

## How to get to it

- Slack: ask Junior in the conversation that gets the results.
- Dashboard: `Automations` in the `Primary` navigation (`/automations`), an Automation page, and its runs.
- MCP server: read-only search and fetch with the `automations:read` scope.
- Runtime triggers: the heartbeat (`/api/internal/heartbeat`) for Schedules, plugin webhooks for Events, Slack message events for channel messages.

## Driving it with browse.mjs

Preconditions:

- `instance.mjs launch --mock` started the instance, and `instance.mjs doctor` passes. The mock serves the Automations list, runs, and versions.
- `S=.agents/skills/verify-junior/scripts` and `E=$RUN_DIR/evidence/automations`.

- **`dashboard`: open an Automation and its runs.** Run `node $S/browse.mjs --out $E --goto /automations --click 'role=link[name="Open automation: Weekly project summary"]' --expect 'role=region[name="Recent runs"]' --snap automation --click 'role=link[name="Runs"]' --expect 'role=region[name="Runs list"]' --snap runs`. Both snapshots show the runs, with their result (completed, failed, blocked) and cost.

## Gotchas

- Creation and management happen in Slack Turns. They need a model, so they have `eval` proofs, not drive steps. `pnpm cli -- chat` also needs a model.
- The mock serves only Automation reads. `Pause` shows "Could not update this automation." and `Versions` shows "Version history could not be loaded.", because those calls reach the real API, which has no mock Automations. That is a missing precondition, not a product failure. The e2e specs route those calls in the browser, so they are the proof. Run them after `instance.mjs stop` (see `SKILL.md`).
- A mock Automation page proves the dashboard surface only. The mock replaces the Automations API, so the server half has its own `test`.
- Each drive step mutates process-local mock state. Restart the instance (`instance.mjs stop`, then `instance.mjs launch --mock`) to start over.

## Gaps

- `run-now`: the test proves the tool and store. No eval proves that Junior calls it when a user asks to run an Automation now.
