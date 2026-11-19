# Automations

A user saves an instruction, and Junior runs it later: on a Schedule, on a matching Event, or on each new message in a Slack channel. Each Automation run posts to the Destination where the user created the Automation, a Slack channel or DM. The Automations pages list each Automation, its runs, and its versions. Intent and rules: `design/automations.md`.

## Sub-features

- `create-scheduled` A user asks for a reminder or recurring work in Slack. Junior saves it without a confirmation step, and posts the result when it is due.
- `create-event` A user asks Junior to act when a resource changes. Each matching Event starts one Automation run, also when the Event is delivered twice.
- `channel-message` A user asks Junior to act on new posts in a channel. Junior replies in the thread of each new top-level message.
- `manage` A user asks to list, reschedule, pause, resume, or delete. Junior changes the existing Automation and creates no new one.
- `move` A user asks, in another Slack conversation, to move an Automation there. Its later runs post there.
- `run-now` A user asks to run a Scheduled automation now. A run starts within a minute, and its next scheduled time does not change.
- `no-action` The condition of the instruction is not met. The run completes and posts nothing.
- `blocked` A run cannot work. Junior blocks the Automation, tells only its creator in a DM, and the Inbox lists it under "Blocked automations".
- `needs-slack` A user asks for an Automation in a dashboard Conversation. Junior creates none and says to ask in a Slack channel or DM.
- `dashboard` A user opens an Automation. The page shows its runs and versions, and the user can edit, pause, resume, or delete it, or make an earlier version active.

## How to get to it (user POV)

- Slack: ask Junior in the channel or DM that gets the results.
- Dashboard: `Automations` in the `Primary` navigation (`/automations`), `Runs` (`/automations/runs`), and an Automation page.
- Dashboard: the `Inbox`, "Blocked automations".
- A dashboard Conversation: the composer, where Junior refuses to create one.

## Driving it with browse.mjs

Preconditions:

- `E=$RUN_DIR/evidence/automations`.
- For `needs-slack`: `instance.mjs launch` (no `--mock`), and `instance.mjs doctor` passes.
- For the Slack sub-features: a Slack workspace with the app installed, a public tunnel to the instance, and a Slack user who is linked to the dashboard viewer. See Gotchas.
- For the `dashboard` read steps without Slack: `instance.mjs launch --mock`, which serves fixed Automations, runs, and versions.

- **Dashboard refuses (`needs-slack`).** Run `node $S/browse.mjs --out $E/needs-slack --timeout 300000 --goto / --fill 'role=textbox[name="Start a conversation"]=Create a scheduled automation that posts the line "verify-junior heartbeat" here every day at 09:00.' --press Enter --idle --expect 'text=/Slack channel or DM/' --snap reply --goto /automations --expect 'text=No automations yet.' --snap list`. Junior says that an Automation needs a Slack channel or DM. The Automations page is empty.
- **Create (`create-scheduled`).** In a Slack channel, send `@junior-example remind me in 2 minutes to check the canary deploy, as a scheduled automation.` Junior confirms without a question. Run `node $S/browse.mjs --out $E/create --goto /automations --expect 'role=link[name=/^Open automation/]' --snap list`. After 2 minutes and one heartbeat, the reminder shows in the Slack channel, and `/automations/runs` lists one completed run.
- **Run now (`run-now`).** Create a daily Automation in Slack, then send `@junior-example run that automation now.` Run `node $S/browse.mjs --out $E/run-now --goto /automations --click 'role=link[name=/^Open automation/]' --expect 'role=region[name="Recent runs"]' --snap page`. Within a minute, "Recent runs" has a new run, and the next run time on the page is the same as before.
- **Manage (`manage`).** In the same channel, send `@junior-example list my automations`, then `move it to 10:00`, `pause it`, `resume it`, and `delete it`, one at a time. After each message, run `node $S/browse.mjs --out $E/manage-<step> --goto /automations --snap list`. The list keeps one Automation that has the new time and state, and after the delete it is empty.
- **Move (`move`).** In a second channel, send `@junior-example move my canary reminder here.` The Automation page shows the new Destination, and the next run posts in the second channel.
- **Event (`create-event`).** In Slack, send `@junior-example when a new issue is opened in <scratch repo>, post its title here.` Open an issue there with `gh issue create -R <scratch repo> -t "verify-junior event" -b test`. `/automations/runs` lists one run, and the title shows in the channel. Redeliver the same webhook from the GitHub App settings: no second run shows.
- **Channel messages (`channel-message`).** In a test channel, send `@junior-example for each new top-level message in this channel, reply in its thread with its word count.` Post `one two three`. Junior replies `3` in that message's thread.
- **No action (`no-action`).** In Slack, send `@junior-example in 2 minutes, post "ALERT" here only if <scratch repo> has an open issue titled "fire". Otherwise post nothing.` After the run, `/automations/runs` lists it as completed, and the channel has no new message.
- **Blocked (`blocked`).** In Slack, ask for an Automation that needs an account that is not connected, for example `@junior-example every day at 09:00, list my open Linear issues here.` After its run, the creator gets one DM that names the block. Run `node $S/browse.mjs --out $E/blocked --goto /review --expect 'role=region[name="Blocked automations"]' --snap inbox`.
- **Dashboard pages (`dashboard`).** With an Automation from Slack, or on `--mock`, run `node $S/browse.mjs --out $E/dashboard --goto /automations --click 'role=link[name=/^Open automation/]' --expect 'role=region[name="Recent runs"]' --snap automation --click 'role=link[name="Runs"]' --expect 'role=region[name="Runs list"]' --snap runs`. Both snapshots show runs with their result and cost. On a live Automation, then pause, resume, edit, open `Versions` and make an earlier version active, and delete it from `Automation actions`. After each action, load the page again and check the new state.

## Gotchas

- An Automation needs a Slack channel or DM as its Destination. A dashboard Conversation and `pnpm cli -- chat` cannot create one, so every sub-feature except `needs-slack` and the mock `dashboard` read needs Slack.
- Slack needs `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in `.env.local`, an app whose Event Subscriptions URL is a public tunnel to `/api/webhooks/slack` (`CLOUDFLARE_TUNNEL_TOKEN`, see `pnpm dev:env`), and a person or Slack user token to send the messages. This skill has no Slack harness.
- `create-event` also needs a GitHub App with a webhook to `/api/webhooks/github` and a scratch repo. See `github.md`.
- A recurring Schedule runs at most once a day. Junior asks again when a user wants it more often. Use a one-off delay for a fast run.
- The local heartbeat runs every 60 seconds. A due run can start up to a minute late.
- The dashboard shows an Automation to a viewer only when they own it or it is public. Link the Slack user to the dashboard viewer first.
- On `--mock`, `Pause` shows "Could not update this automation." and `Versions` shows "Version history could not be loaded.", because those calls reach the real API, which has no mock Automations. Report them as unreachable on the mock, not as passed.
- Mock state is process-local and changes as you drive. Stop and launch again to start over.
