---
name: verify-junior
description: Prove what Junior does by launching the local example app (`pnpm dev`) and driving it the way a user does, through the dashboard (Conversations, Inbox, Automations, System) with Playwright, and capturing the action, the resulting state, and the side effects. Use when asked to verify or prove a Junior behavior, to check a sub-feature such as `inbox#waiting` or `guardian#decision-recorded`, or to collect live evidence for a PR. Do not use for writing tests or evals, or for Slack or GitHub behavior on a machine with no Slack workspace or GitHub App.
---

# Verify Junior

Users touch Junior in Slack (Turns and Inbox item cards), in the dashboard (Conversations, Inbox, Automations, System), and on GitHub (PRs, issues). The local example app (`apps/example`) serves the dashboard and runs real Turns, with a real model, in a queue worker. A message sent from the dashboard composer runs the same agent, tools, Guardian review, and Inbox as Slack. Slack and GitHub need their own credentials (see each feature's `Gotchas`).

Helpers are Node scripts in `scripts/`. Run them from the repo root. The feature map is [features/README.md](features/README.md).

```sh
S=.agents/skills/verify-junior/scripts
```

## Launch

1. Once per checkout: `pnpm install` and `pnpm build`. Once per machine: `pnpm exec playwright install chromium`.
2. A live Turn needs a model: `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` in `.env.local` (`pnpm dev:env`). Check it with the `one-reply` drive in `features/background-work.md`. A reply that says the model is not configured means no credential.
3. Start the instance:

   ```sh
   RUN_DIR=$(node $S/instance.mjs launch | tail -1)
   ```

   - Each run gets a new, empty Postgres database (`verify_junior_<run>`) and an empty Redis database (1 to 15) in the compose services. `pnpm dev` migrates the database. Your `junior` database and Redis database 0 are not touched.
   - `--mock` sets `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true`. The dashboard then shows fixed Conversations, Inbox items, Automations, and stats, and the composer runs no agent. Use it only where a feature file says so.
   - `launch` refuses when port 3000 or 8969 is in use. `pnpm dev` binds both, so only one instance can run on a machine.
   - `pnpm dev` runs inside `sentry local run`, so Nitro reports to one Sentry Local server on port 8969. `launch` tails it to `$RUN_DIR/telemetry.ndjson`. See [Telemetry](#telemetry).
   - It generates a disposable `JUNIOR_ENCRYPTION_KEYS` and never writes it to a file.
   - It deletes the injected `dist` symlinks that an earlier `pnpm dev` left under `node_modules/.pnpm/@sentry+junior*`. With them, pnpm 12 fails the build with `ERR_PNPM_INJECTED_DEPS_SYNC_READ_DIR`.
   - A cold start takes 2 to 4 minutes.
4. Ready means `GET /` and `GET /api/health` both return `200`. `launch` waits for both, then prints `ready: http://localhost:3000 (mock=false)` and the run directory. Local development has no sign-in. The viewer is `dev@example.com`.

Teardown is [Cleanup](#cleanup).

## Doctor

Run `node $S/instance.mjs doctor $RUN_DIR` before the first drive, after any failed drive, and when anything looks wrong. It is read-only and exits `0` only when every line is `ok`:

- `pnpm dev` from this run is up, and the port 3000 listener descends from it.
- The telemetry tail of this run is up.
- `GET /api/health` returns `200`.
- The mock mode matches the launch.
- `HEAD` is still the launched revision.
- Compose `postgres` and `redis` run, and the run database exists.

Doctor cannot see a wedged page or a stuck Turn on a healthy process. Then open a new Conversation, or stop and launch again.

## Drive

`node $S/browse.mjs --out DIR [--width PX] [--touch] [--timeout MS] STEP...` drives the dashboard with Playwright. `--touch` emulates a phone with a touch screen. Use it with `--width 390`. Steps run in order:

- `--goto PATH_OR_URL`, `--back NAME` (the URL that an earlier `--snap NAME` saved), `--click SELECTOR`, `--fill SELECTOR=TEXT`, `--type SELECTOR=TEXT` (key by key, as a person types), `--press KEY`, `--hover SELECTOR`, `--tap SELECTOR` (needs `--touch`).
- `--upload SELECTOR=PATH[,PATH]` sets the files of a file input, such as `role=button[name="Choose files"]`. `--select SELECTOR` selects the text of the element, as a mouse drag does.
- `--expect SELECTOR` waits until it is visible. `--absent SELECTOR` waits until none is visible, and it also passes when the element never showed.
- `--title PREFIX` waits for the tab title. `--order A|B|C` waits for the texts in that order.
- `--idle` waits until the open Conversation has no running Turn for 3 seconds.
- `--snap NAME` writes `NAME.aria.yml`, `NAME.png`, `NAME.title.txt`, and `NAME.url.txt`.

Selectors are Playwright selectors. Use ARIA handles, such as `role=textbox[name="Start a conversation"]` or `role=region[name="Needs you"]`. The run stops at the first failed step and saves `failure.png`. A live Turn takes 10 seconds to several minutes, so drives that wait for a reply use `--timeout 300000`.

Most recipes start a Conversation from the composer and come back to it later. Junior renames a Conversation after the first reply, so go back by URL, not by title: `--snap` after `--idle` records the URL. The same drive goes back with `--back NAME`, and a later drive with `--goto "$(cat DIR/NAME.url.txt)"`.

`node $S/instance.mjs crash-worker $RUN_DIR [--when FILE]` makes Nitro replace the app worker of this run, the way a code change does. This stops a running Turn. See `features/background-work.md`.

## Evidence

Put all evidence in `$RUN_DIR/evidence/<feature>/`. `$RUN_DIR` defaults to `${TMPDIR:-/tmp}/verify-junior/<UTC time>-<pid>`, outside the checkout.

- Use the real user path: the dashboard composer, its buttons and forms, the Inbox, and the dashboard pages. Do not call internal setters, test-only endpoints, or write database rows.
- Capture the action and the result. A `--snap` after the action, and a second view (another page, a search, a count), is the proof. A toast or the agent's own words alone are not.
- Check side effects: the Inbox count and tab title, the item in search, the event log of the Conversation, the System page counts.
- The model is real. Do not mock it. `--mock` replaces Junior's own API, so it proves only what the dashboard shows.
- `dev.log` in `$RUN_DIR` has the server logs. Use it to explain a failure, not as proof.

## Telemetry

`$RUN_DIR/telemetry.ndjson` has one JSON object per line for each error, span, and log that Nitro sends. Use it to explain a result or a failure, such as which tool ran, which model call failed, or which step was slow. It is not proof of what a user sees.

- `type` is `error`, `span`, `log`, or `session`. Logs have `level` and `message`, which is the event name, such as `agent.turn.timed_out`. Errors have `error_type`, `message`, the top frame, and `trace_id`.
- Spans have `label`, `duration_ms`, `status`, and `attributes.sdk["sentry.op"]`, the full span name: `gen_ai.invoke_agent`, `gen_ai.chat`, `gen_ai.execute_tool`, `queue.process`. `TELEMETRY.md` has the names and attributes.
- Turn spans and logs carry `gen_ai.conversation.id`. It is the last path segment of the Conversation URL, URL-decoded, such as `local:web:9a15...`.
- One Conversation: `grep '"gen_ai.conversation.id":"local:web:<id>"' $RUN_DIR/telemetry.ndjson`. Its errors: `grep '"type":"error"' $RUN_DIR/telemetry.ndjson | grep '"trace_id":"<trace>"'`, with a `trace_id` from its spans.

## Cleanup

```sh
node $S/instance.mjs stop $RUN_DIR
```

It stops the `pnpm dev` process tree that `launch` recorded, never processes found by name. It drops the run database and flushes the run Redis database. It stops only the compose services that were not running before launch. It keeps `$RUN_DIR` and its evidence. A failed launch runs it by itself. Run it after a failed drive too, so that no process keeps port 3000. Then check that `$RUN_DIR/evidence` still has the artifacts.

## Map

Read [features/README.md](features/README.md). Cite a sub-feature as `<file>#<id>`, for example `inbox#first-answer-closes`. Keep the map current with the `maintain-verification-skill` skill.
