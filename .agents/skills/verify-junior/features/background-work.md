# Background work

Junior runs Turns, child agents, and Automation runs in short serverless slices. Users never see a slice, but they rely on the result: each request gets its reply even when a host limit, a retry, or a killed worker interrupts the work. Policy: `policies/serverless-background-work.md`.

## Claims

- `one-reply` A user mentions Junior once. The user gets one reply, and the Conversation is free for the next message. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/durable-queue.test.ts -t "runs one mention to one reply and leaves the conversation free"`.
- `host-limit` A user's request runs past the host time limit. The Turn parks and continues in a new slice, and the user still gets the reply. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/durable-queue.test.ts -t "re-parks when a later attempt times out before any new work is saved"`.
- `lost-wake` The wake of a paused Turn is lost. The heartbeat finds the stale Turn and schedules it again, so the user is not left waiting. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/heartbeat.test.ts -t "reschedules stale paused turn records|reschedules stale cooperative yield continuation records"`.
- `worker-killed` The worker of a child agent is killed. The child resumes from its last save. When every try is killed, the parent hears about it instead of waiting forever. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/agent-invocation-worker-crash.test.ts -t "resumes a killed child from its last save|tells the parent when every try of a child worker is killed"`.
- `run-once` A Schedule is due, or an Event arrives twice. Each due occurrence or Event starts one Automation run. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/scheduled-automation-tools.test.ts tests/integration/event-automations.test.ts -t "claims due runs idempotently|fans one event out to every matching task and deduplicates retries"`.
- `signed-wake` A wake carries only a signed, small envelope with a delay and an idempotency key. The work payload stays in durable state. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/conversation-queue.test.ts -t "sends a signed wake with delay and idempotency"`.

## How to get to it

- A Slack mention, a dashboard message, or an Event queues a Conversation wake.
- `/api/internal/heartbeat` runs each minute. `pnpm dev` calls it with the local scheduler secret.
- A host time limit, a deploy, or a killed worker interrupts a slice.

## Driving it with proofs.mjs

Preconditions:

- Compose Postgres is healthy. `instance.mjs launch` starts it, or run `docker compose up -d --wait postgres redis`.
- The run directory is `$RUN_DIR`.

- **`one-reply`, `host-limit`, `lost-wake`, `worker-killed`, `run-once`, `signed-wake`: run the tests.** Run `node .agents/skills/verify-junior/scripts/proofs.mjs run --out $RUN_DIR/evidence/background-work .agents/skills/verify-junior/features/background-work.md`. Each command exits `0`.

## Gotchas

- These faults need injected time limits and killed workers, so no claim here has a `drive` proof. Do not kill a dev server process to fake one: `pnpm dev` restarts Nitro, and the run proves nothing.
- The dev server logs `Local heartbeat failed: fetch failed` once at startup, before Nitro listens. It is not a `lost-wake` failure.
- The tests fake only Slack and the model, as `AGENTS.md` requires. A failure here is a runtime failure, not a fixture problem.

## Gaps

None.
