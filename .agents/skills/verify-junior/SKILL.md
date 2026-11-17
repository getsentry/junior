---
name: verify-junior
description: Prove what Junior does by launching the local example app (`pnpm dev`), driving its dashboard with Playwright, and running the integration tests and evals that the claim map names. Use when asked to verify or prove a Junior behavior, to check a claim such as `automations#run-now` or `review-desk#waiting`, to collect evidence for a PR, or to find which claims have no proof. Do not use for writing new tests or evals, or for Slack-only QA that needs a real workspace.
---

# Verify Junior

Junior's surfaces are Slack (Turns and Review item cards), the dashboard (Conversations, Inbox, Automations), GitHub (PRs, issues, webhooks), and runtime systems that users rely on but do not touch (the conversation queue, the heartbeat, child agent workers). The local example app (`apps/example`) runs all of them except Slack and GitHub. Slack and GitHub are faked at their HTTP boundary in integration tests, and the model is replayed or called in evals.

All helpers are Node scripts in `scripts/`. Run them from the repo root as `node .agents/skills/verify-junior/scripts/<name>`. The claims and their proofs are in [map/README.md](map/README.md).

## Launch

1. Once per checkout: `pnpm install` and `pnpm build`. Once per machine: `pnpm exec playwright install chromium`.
2. Start the instance:

   ```sh
   S=.agents/skills/verify-junior/scripts
   RUN_DIR=$(node $S/instance.mjs launch --mock | tail -1)
   ```

   - `--mock` sets `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true`, so the dashboard shows fixed Conversations, Review items, and Automations. Leave it out for an empty live instance.
   - `instance.mjs launch` refuses when port 3000 or 8969 is in use. `pnpm dev` binds both, so two instances cannot run on one machine.
   - It generates a disposable `JUNIOR_ENCRYPTION_KEYS` for the run. It never writes the key to a file.
   - It deletes the injected `dist` symlinks that an earlier `pnpm dev` left under `node_modules/.pnpm/@sentry+junior*`. With them, pnpm 12 fails the build with `ERR_PNPM_INJECTED_DEPS_SYNC_READ_DIR`. `pnpm dev` links them again, and `stop` deletes them.
   - `pnpm dev` starts compose Postgres, Redis, and S3, builds the packages, and applies migrations. A cold start takes 2 to 4 minutes.
3. Ready means `GET /` and `GET /api/health` both return `200`. `instance.mjs launch` waits for both, then prints `ready: http://localhost:3000 (mock=true)` and the run directory. The dashboard has no sign-in in local development. The viewer is `Dashboard User` (`dev@example.com`).

Teardown is [Cleanup](#cleanup).

## Doctor

Run `node $S/instance.mjs doctor $RUN_DIR` before you drive, and again when anything looks wrong. It is read-only and exits `0` only when every line is `ok`:

- `pnpm dev` from this run is up, and the port 3000 listener descends from it.
- `GET /api/health` returns `200`.
- The mock mode matches the launch (`/api/versions` returns `"reviewItems":"mock"` only with `--mock`).
- `HEAD` is still the launched revision.
- Compose `postgres` and `redis` run.

## Drive

- **Dashboard:** `node $S/browse.mjs --out DIR STEP...`. Steps run in order: `--goto PATH`, `--click SELECTOR`, `--fill SELECTOR=TEXT`, `--press KEY`, `--expect SELECTOR`, `--absent SELECTOR`, `--title PREFIX`, `--order A|B|C`, and `--snap NAME`. Selectors are Playwright selectors. Use ARIA handles, such as `role=region[name="Needs you"]` or `role=link[name="Inbox 4"]`. The run stops at the first failed step and saves `failure.png`.
- **Tests and evals:** `node $S/proofs.mjs check` resolves every proof command in the map without running it. `node $S/proofs.mjs run --out DIR [--kind test|eval|e2e] [MAP_FILE...]` runs each distinct command once. A command passes only when it exits `0` and at least one test passes for each `-t` or `--grep` pattern, because Vitest exits `0` when `-t` matches nothing.
  - Integration tests (`--kind test`) need compose Postgres. They can run while the instance runs.
  - Run `--kind e2e` only after `instance.mjs stop`. `pnpm test:e2e:dashboard` rebuilds the packages, and a rebuild under a running `pnpm dev` stops it with `MODULE_NOT_FOUND` for `@sentry/junior`.
  - With `CI` set, the e2e config uses the installed Chrome (`/opt/google/chrome`). Without that Chrome, run `env -u CI node $S/proofs.mjs run --kind e2e ...`.
- **Agent behavior:** `pnpm cli -- chat -p "<prompt>"` runs one local Turn. It needs a model (`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` from `pnpm dev:env`). See the `junior-qa` skill. It has no Slack cards or Slack delivery.

The map file of each system has the exact steps.

## Evidence

Put all evidence in `$RUN_DIR/evidence/<map file>/`. `$RUN_DIR` defaults to `${TMPDIR:-/tmp}/verify-junior/<UTC time>-<pid>`, outside the checkout.

- Use the real user path: dashboard routes and buttons, the CLI, and the test or eval commands in the map. Do not call internal setters or write database rows.
- Capture the action and the result. A `--snap` after the action and a second view (a new `--goto`, a search, or the count) is the proof. A toast alone is not.
- Check side effects: the Inbox count, the tab title, a closed item in search, a test log with exit `0`.
- Use mocks only where a production boundary isolates the external system. Integration tests fake Slack, GitHub (MSW), and the model. The dashboard mock replaces Junior's own API, so it proves only what the dashboard shows. Each claim that depends on a server rule also names a `test`.
- `ROACH_MODE=replay` in evals replays recorded model calls. It still needs `ROACH_TOKEN`: without it, global setup fails with `Roach: POST runs failed with HTTP 401` and no case runs. `ROACH_MODE=off` needs a model credential and `cloudflared` for the eval egress tunnel instead.

## Cleanup

```sh
node $S/instance.mjs stop $RUN_DIR
```

It stops the `pnpm dev` process tree that `launch` recorded, never processes found by name. It stops only the compose services that were not running before launch. It keeps `$RUN_DIR` and its evidence. After a failed launch, run it too, so that no process keeps port 3000.

## Map

Read [map/README.md](map/README.md). Cite a claim as `<file>#<id>`, for example `review-desk#first-answer-closes`. When a claim has no runnable proof, it is under the `Gaps` section of its map file. Keep the map current with the `maintain-verification-skill` skill.
