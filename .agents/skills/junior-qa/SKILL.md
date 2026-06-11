---
name: junior-qa
description: QA Junior changes through the local chat CLI and apps/example without Slack. Use when validating Junior agent behavior, runtime/tool/prompt/plugin changes, local-vs-Slack regressions, or PR readiness with real `junior chat -p` probes.
---

Use the local Junior chat CLI as a real agent QA surface before relying on Slack. The goal is to prove the shared agent/runtime path works from `apps/example`, then add narrower tests or evals for the exact contract that changed.

## Step 1: Classify the Change

| Change area                                                                 | Local QA probe                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Core reply generation, prompt, source/requester context, or local CLI       | Exact-output `chat -p` smoke plus one targeted scenario prompt                     |
| Skills or plugin discovery                                                  | `/example-local` and `/example-bundle-help` probes from `apps/example`             |
| Tool runtime context or provider-neutral tools                              | Targeted natural-language prompt plus focused integration tests                    |
| Credentialed provider, MCP, sandbox, scheduler, or durable state behavior   | Local CLI as a non-Slack smoke, then targeted integration tests or evals           |
| Slack-specific formatting, delivery, mentions, files, reactions, or retries | Local CLI is insufficient; use Slack MSW/integration coverage from the Slack specs |

Read `specs/local-agent.md` first, then read the relevant feature spec for the changed behavior. If tests are added or changed, read `specs/testing.md` before choosing the layer.

## Step 2: Run Local Preflight

Use `apps/example` through the repo CLI:

```sh
pnpm cli -- chat -p "Say exactly: junior qa smoke ok"
```

For ordinary local QA, expect the CLI to default to memory state. Set `JUNIOR_STATE_ADAPTER=redis` only when durable Redis state is the behavior under test.

Treat startup logs as useful evidence. A healthy `apps/example` run should load `SOUL.md`, `WORLD.md`, the `example-bundle` plugin, and discover both `example-local` and `example-bundle-help`.

## Step 3: Exercise the Example App

Run these probes when validating local agent or plugin/skill behavior:

```sh
pnpm cli -- chat -p "/example-local confirm local QA discovery"
```

Expect the answer to follow the `example-local` skill from `apps/example/app/skills` and confirm local skill discovery.

```sh
pnpm cli -- chat -p "/example-bundle-help"
```

Expect the answer to explain that the skill is discovered from `app/plugins/example-bundle/skills`, is bundled with `example-bundle`, has no credential configuration, and does not support `jr-rpc issue-credential`.

## Step 4: Add a Targeted Scenario

Craft one small prompt that exercises the changed behavior in user terms. Keep the assertion narrow enough to inspect from the final CLI answer:

```sh
pnpm cli -- chat -p "<targeted prompt>"
```

Prefer exact-output prompts for low-level routing or prompt-context checks. Prefer integration tests or evals when the behavior depends on tool wiring, model judgment, continuity, natural-language routing, or provider credentials.

## Step 5: Verify the Contract

Local QA supplements, but does not replace, repo validation:

1. Run package typechecks for code changes, such as `pnpm --filter @sentry/junior typecheck`.
2. Run focused tests for deterministic product/runtime behavior.
3. Run evals for model-facing behavior, prompt interpretation, routing, continuity, or reply quality.
4. Run Slack-specific tests when the change touches Slack-only behavior.

## Failure Handling

If local CLI output shows Redis DNS errors or hangs while connecting to Redis, check whether `JUNIOR_STATE_ADAPTER=redis` was set explicitly. Ordinary local chat should default to memory even when `.env.local` contains `REDIS_URL`.

If the run fails with a model gateway connection error, rerun with host network access when available. If credentials are missing or expired and the check requires real providers, refresh with `pnpm dev:env` before retrying.

If a model answer is too loose to prove the behavior, replace it with an exact-output prompt or move the assertion into an integration test or eval.

## Report Results

Summarize the exact commands run, the final output or assertion that passed, whether local QA was sufficient or only supplemental, and any remaining tests/evals. Do not claim Slack behavior is proven by local CLI unless the changed behavior is platform-neutral and already covered at the shared runtime boundary.
