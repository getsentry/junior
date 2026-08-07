# Evals Spec

## Intent

Evals are end-to-end Slack conversation evaluations. They are the integration-style test layer for agent-facing behavior when model interpretation is part of the contract.

There are three independently runnable suites:

1. **Integration** (`evals/integration/**`) — full agent/runtime runs for primary system functionality that should never regress. Failures are hard pass/fail.
2. **Qualitative** (domain folders under `evals/` except `integration/` and `guardian/`) — full agent/runtime runs that measure behavioral quality and tolerate bounded variability. CI reports a suite score and only blocks below the configured floor.
3. **Guardian** (`evals/guardian/**`) — isolated decision snapshots scored only on `allow` / `ask` / `deny`. Failures are hard pass/fail.

- We define conversation cases inline in TypeScript using `describeEval()` and the shared `slackEvals` harness options.
- We run the real runtime/harness against those fixtures.
- We score outcomes against the normalized `vitest-evals` session surface, backed by Junior's Pi client. The eval runtime pins standard to `xai/grok-4.5`, auxiliary work to `anthropic/claude-haiku-4.5`, Guardian review to `openai/gpt-5.6-luna`, and handoff continuation to `openai/gpt-5.6-sol`, so model-specific behavior stays reproducible.

## Layer Boundaries

Testing taxonomy and layer contracts are defined in:

- `policies/testing.md`
- `packages/junior/tests/README.md`
- `policies/evals.md`

Quick mapping:

- `tests/integration/*`: Slack/runtime integration and HTTP contract tests.
- `evals/*`: Integration-style coverage for conversation-level agent behavior and quality scoring through the runtime harness.
- `tests/unit/*` (or non-integration tests): isolated logic/invariant tests.

This separation is enforced by `pnpm lint`.

## What Is In Scope

- Conversation-level behavior under realistic thread/message flows.
- Tool use and output behavior as observed by the runtime.
- Slack-visible metadata exposed by the runtime and harness.

Not in scope:

- Isolated unit behavior (belongs in unit tests).
- Low-level Slack HTTP payload contract checks (belongs in integration tests).

## Sources Of Truth

- Integration system behavior: `evals/integration/`
  - primary runtime/system correctness that must never regress (hard pass/fail)
- Qualitative conversation behavior: `evals/conversation/`
  - routing, actor attribution, continuity, delivery, storage, attachments, and output
- Qualitative agent behavior: `evals/agent/`
  - skills, providers, research, files, OAuth, subscriptions, and skill routing
- Qualitative feature behavior:
  - `evals/event-tasks/`
  - `evals/memory/`
  - `evals/scheduler/`
  - `evals/github/`
  - `evals/sentry/`
- Isolated Guardian decisions: `evals/guardian/`
  - exact `ToolActionProposal` snapshots scored only on `allow` / `ask` / `deny`
- Helpers and event builders: `src/helpers.ts`
- Guardian harness: `src/guardian-harness.ts`
- Harness/runtime adapter: `src/behavior-harness.ts`

## Execution Model

For each `it()` case inside a `describeEval()` suite:

1. Replay events through the harness via `runEvalScenario()`.
2. Create a fresh runtime instance for the case via the chat composition root; do not mutate the production singleton runtime.
3. Route message events through real ingress + queue-worker behavior, with only the external queue transport replaced by an in-memory harness shim.
4. Return a standard `vitest-evals` `HarnessRun`; `result.session.messages` is the canonical normalized transcript, while tool calls and artifacts remain available for deterministic assertions.
5. Do not create a second repo-local transcript, event-log, or assertion schema when `vitest-evals` already has `session`, `toolCalls(result.session)`, `artifacts`, or `traces`.
6. When a case supplies `criteria`, `vitest-evals` scores its normalized visible transcript (A–E -> 1.0-0.0). Deterministic-only cases omit `criteria` and use direct assertions without a model judge.

## Harness Boundaries

- Use the Slack eval harness for Slack/runtime behavior: mentions, thread/channel delivery, OAuth privacy, lifecycle/resume behavior, reactions, and Slack-visible side effects.
- Use an agent-level harness for prompt, skill routing, tool choice, provider/tool calls, and reply quality when Slack transport is not the behavior under test.
- The Slack eval harness preserves inbound messages and direct thread replies in observed order. Slack API-captured side effects may be collected afterward. The rubric judge receives only non-empty user-visible text plus visible Slack author names from normalized user and assistant messages; tool calls, artifacts, logs, other metadata, and other runtime observations stay outside its prompt.
- Omit `criteria` for deterministic-only cases. Use shared typed selectors plus explicit assertions for tool calls, reactions, attachments, persistence, and delivery side effects; the rubric judge is reserved for nondeterministic visible reply quality.
- When the eval boundary is Junior's Pi agent or needs an ordered full-turn transcript, prefer `@vitest-evals/harness-pi-ai` primitives instead of rebuilding transcript capture locally. The Pi harness already owns normalized `session.messages`, `toolCalls(result.session)`, artifacts, traces, replay, and judge context.
- Do not assert against logs, spans, or status telemetry for product behavior. Use `vitest-evals` session/tool/artifact primitives for behavior contracts; reserve traces/spans for instrumentation tests or diagnostics.

Harness override knobs (in `EvalOverrides`):

- `active_turn_compaction`: seeds an active-turn compaction boundary so an eval can exercise model continuation without manufacturing oversized tool output.
- `auto_complete_mcp_oauth`: after our app genuinely starts an MCP OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `auto_complete_oauth`: after our app genuinely starts a generic OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `credential_providers`: seed normal provider credentials for the listed providers. GitHub uses dummy GitHub App env vars plus an intercepted installation-token exchange; Sentry uses the normal OAuth token store.
- `mock_image_generation`: stub the image-generation HTTP response with a valid image payload while still exercising the real attachment path.
- `plugin_dirs`: load plugin fixtures from eval-local directories without adding workspace packages.
- `reply_texts`: override returned reply text per call.
- `reply_timeout_ms`: lower or set the per-reply harness timeout for a specific scenario. It cannot exceed 60 seconds.
- `subscribed_decisions`: controls the subscribed-message reply gate in the harness. If you use it, do not claim that reply-selection behavior is being validated by the eval itself.
- `timeout_resume`: seeds a durable timeout continuation boundary with an unknown tool outcome before the real model runs. Use it to evaluate continuation behavior without wall-clock sleeps.

These knobs work by overriding services on the eval-local runtime instance. They must not reintroduce mutable global runtime behavior seams.

Tool replay:

- `webFetch` and `webSearch` are wrapped with `vitest-evals/replay` in the eval harness. Use `pnpm evals:record` to force fresh recordings under `.vitest-evals/recordings`.
- Keep committed recordings minimal and source-specific. Regenerate them from the evals that need replay, then review for stale exploratory fetches and secret-like values before committing.

## Running

- `pnpm evals` / `pnpm evals:qualitative`: Run the qualitative suite
- `pnpm evals:integration`: Run the integration suite
- `pnpm evals:guardian`: Run isolated Guardian decision snapshots
- `pnpm --filter @sentry/junior-evals evals:qualitative`: Run qualitative from any directory
- `pnpm --filter @sentry/junior-evals evals:integration`: Run integration from any directory
- `pnpm --filter @sentry/junior-evals evals:guardian`: Run Guardian from any directory
- `pnpm --filter @sentry/junior-evals evals:qualitative evals/sentry/skills.eval.ts`: Run one qualitative file
- `pnpm --filter @sentry/junior-evals evals:integration evals/integration/conversation/actions.eval.ts`: Run one integration file
- `pnpm --filter @sentry/junior-evals evals:guardian evals/guardian/action-review.eval.ts -t "deny"`: Run one Guardian case
- `pnpm --filter @sentry/junior-evals evals:qualitative --shard=1/4`: Run one of the four CI qualitative shards

Pass eval file paths, `-t` filters, and shard options directly after the suite script. Do not use `pnpm exec vitest` directly, and do not insert `--` before eval arguments.

## Optional CI Runs

- On pull requests, the `Evals` workflow can start three independent suites:
  - qualitative Slack/agent evals (`evals / qualitative *` + `evals / report`)
  - integration system evals (`evals / integration *`)
  - isolated Guardian snapshots (`evals / guardian`)
- Suite labels follow `trigger-evals-[domain]`:
  - `trigger-evals` starts all suites
  - `trigger-evals-qualitative`, `trigger-evals-integration`, and `trigger-evals-guardian` start one suite
- Qualitative and integration evals require both gateway and sandbox secrets. Guardian only needs gateway credentials.
- Adding a trigger label fires immediately; unrelated labels do not.
- Qualitative path triggers cover domain folders under `evals/{agent,conversation,event-tasks,github,memory,scheduler,sentry}/`, shared harness files, and `packages/junior/src/**`.
- Integration path triggers cover `evals/integration/**`, the invariant config, shared harness files, and `packages/junior/src/**`.
- Guardian path triggers cover `evals/guardian/**`, the Guardian harness/config, and Guardian policy/reviewer inputs under `packages/junior/src/chat/services/guardian-action-*.ts` and `tool-support/action-review*`.
- Qualitative shards still fail individual cases under the per-case judge threshold (`0.75`), but the workflow no longer fails the job on those case failures alone.
- After all qualitative shards finish, `evals / report` combines results, publishes the suite summary, and posts an `eval score / qualitative` Check Run whose PR status line is the pass rate (for example `63.7% passed · required 80.0%`).
- The qualitative floor is `EVAL_MIN_PASS_RATE=0.8` (`80%` of cases passed). Missing shard result files or setup/runtime crashes before results are written remain hard failures on the report job.
- Integration cases fail the `evals / integration *` jobs hard on any miss. They do not use the aggregate pass-rate floor.
- Guardian cases assert exact `allow` / `ask` / `deny` decisions and fail the `evals / guardian` job hard on mismatch. They do not use the aggregate pass-rate floor.
- The `vitest-evals` Check Run stays off because v0.15.0 still concludes it from any single case failure.
- The simplest Gateway and Sandbox setup is `VERCEL_OIDC_TOKEN` alone.
- The fallback CI setup is `AI_GATEWAY_API_KEY` plus `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
- Qualitative and integration global setup starts one Cloudflare Quick Tunnel for the suite so Vercel Sandbox can reach the eval egress proxy. Transient tunnel allocation failures retry up to five times with backoff. Local runs require `cloudflared` on `PATH`; CI installs a pinned binary.
- Qualitative and integration state always uses a loopback Redis. Local runs default to `redis://127.0.0.1:6382`; CI sets `JUNIOR_EVAL_REDIS_URL` for its Redis service.
- Setup details for GitHub Actions live in `evals/github-actions.md`.

Qualitative and integration evals require real Vercel Sandbox access and public Quick Tunnel connectivity. If either bootstrap fails, the eval fails immediately with no local fallback path. Guardian evals only need AI Gateway access.

## Authoring Rules

- Put full-runtime integration cases that must never regress under `evals/integration/**` using `describeEval()` with `slackEvals`. Prefer deterministic assertions; keep criteria only when the case still needs light quality scoring.
- Put qualitative behavioral cases under `evals/conversation/`, `evals/agent/`, or `evals/<feature>/` using `describeEval()` with `slackEvals`.
- Add isolated Guardian decision snapshots under `evals/guardian/` using `describeEval()` with `guardianEvals`. Feed exact `ToolActionProposal` objects and assert only the expected `allow` / `ask` / `deny` decision.
- Put messages that should be pending before processing starts in `initialEvents`.
- Put ordinary later events in `events`; each is delivered after preceding work settles.
- Wrap messages with `steer(...)` when they should arrive through normal ingress while the preceding agent run is active.
- Use event builders (`mention`, `threadMessage`, `threadStart`) from `src/helpers.ts`.
- Use `auto_complete_mcp_oauth` or `auto_complete_oauth` when the harness should instantly complete the fake provider callback after our app has genuinely initiated auth.
- For multi-turn, pass the same `thread` override so events land in one thread.
- Keep each case focused on one primary behavior.
- Put semantic, model-dependent expectations in `criteria`.
- Put deterministic boundary expectations in normal Vitest assertions against `result.session`, `toolCalls(result.session)`, or `result.artifacts`. Prefer `vitest-evals` primitives over local helper-specific output shapes.
- When an eval judges nondeterministic visible output, express `criteria` with `rubric({ pass, fail })`.
- Let the eval test name describe the scenario and expected outcome.
- `pass` should list observable pass conditions.
- `fail` should list forbidden outputs or failure conditions.
- Do not write judge criteria as one dense paragraph.
- Let the `describeEval()` block own the behavior area. The file path and `describeEval()` context already provide scope.
- Each eval name should only state the specific scenario and outcome.
- Prefer `when <trigger>, <outcome>` over vague labels like `continuity: remembers prior turn context`.
- Keep user prompts natural. They should read like plausible user requests, not scripted implementation instructions.
- Do not tell the assistant which exact internal command, tool, skill-loading step, or transport sequence to use unless that exact surface is what the user would naturally say and is the behavior under evaluation.
- If an eval only passes when the prompt prescribes internal mechanics, the eval is invalid and the product behavior is not adequately covered.

Scenario scheduling uses three forms:

```ts
await run({
  initialEvents: [
    threadMessage("A provider linked incident OPS-123 to this thread"),
  ],
  events: [
    steer(mention("@junior summarize the incident")),
    threadMessage("Now include the rollout owner"),
  ],
  criteria: rubric({
    pass: ["The assistant follows the direct request and later follow-up."],
  }),
});
```

- `initialEvents` are pending before processing starts. Multiple initial events must be Slack messages and form one mailbox batch.
- `steer(...)` delivers message events through normal ingress while the preceding agent run is active. Steering messages must target that same Slack conversation.
- Plain `events` are ordinary later events delivered after preceding work settles.

Do not do these in eval files:

- Do not import `@/chat/slack/*` directly.
- Do not use MSW Slack helpers (`queueSlackApiResponse`, `getCapturedSlackApiCalls`, `queueSlackApiError`, `queueSlackRateLimit`).
- Do not validate raw Slack Web API request payload shapes from evals.
- Do not invent parallel transcript, event-log, or tool-call schemas for assertions. If the existing `vitest-evals` primitives are insufficient, improve the harness boundary first.
- Do not validate implementation internals (exact tool names, sandbox IDs, or other non-user-visible details) unless the scenario explicitly evaluates those surfaces.

## File Organization

Organize files by suite policy first, then by the user-visible area they exercise:

- `evals/integration/`: strict full-runtime integration cases (hard pass/fail).
- `evals/conversation/`, `evals/agent/`, `evals/<feature>/`: qualitative behavioral cases (score-gated in CI).
- `evals/guardian/`: isolated Guardian decision snapshots (no main agent; hard pass/fail).
- Use short behavior nouns for filenames: `routing.eval.ts`, `delivery.eval.ts`, `credentials.eval.ts`.
- Keep one coherent behavior area per file. Split files when cases exercise independently understandable journeys.
- Keep shared setup in a nearby `helpers.ts`; helpers are not eval files and do not define suites.
- Test names inside a describe block use `when <trigger>, <user-observable outcome>`.

## Eval Quality Rubric

Follow `policies/evals.md` for the repo-wide defaults on invariant-based criteria and over-prescription.

Good conversational evals should:

- Start from realistic user events/messages (mentions, follow-ups, thread lifecycle events).
- Describe user-visible outcomes first (what the assistant communicates, what Slack users can observe, and any visible metadata effects).
- Use concrete real-world scenarios (incident updates, planning follow-ups, capability setup requests), not abstract mechanics like "posted two replies."
- Use judge criteria written in product language, not implementation language.
- Use rubric sections that are easy for maintainers to scan in a failure: a short `pass` list and a focused `fail` list only when it describes a real regression.
- Keep rubric bullets at the behavior level. Prefer "uses the stored repo as the target" over requiring exact wording or incidental reply ordering.
- Assert reply counts, tool calls, database rows, and other deterministic side effects outside the rubric when they are part of the contract.
- Omit incidental variation from the rubric unless it affects the behavior contract.
- Omit `fail` bullets unless they describe a real regression or unsafe side effect.
- Use fake/nonexistent external targets unless the eval explicitly opts into live provider access.
- Cover realistic failure behavior with clear user-visible errors.
- Use `toolCalls(result.session)` when tool/provider evidence proves behavior at a real boundary, such as source grounding, mutation safety, provider routing, or auth sequencing.

Avoid:

- Criteria tied to exact internal tool call names (`bash`, etc.) when user-visible behavior is what matters.
- User prompts that prescribe exact internal commands or tool choices just to force the desired path.
- Prompts that can hit random external URLs or mutate real provider resources for a behavior that can be tested with fake references.
- Cases that only validate mocks or internal state transitions without conversational context.

## Minimal Case

```typescript
import { assistantMessages, describeEval } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Routing", slackEvals, (it) => {
  it("when explicitly mentioned, post one direct reply", async ({ run }) => {
    const result = await run({
      initialEvents: [mention("Summarize this")],
      criteria: rubric({
        pass: ["The assistant answers the user's summary request."],
      }),
    });

    expect(
      assistantMessages(result.session).filter(
        (message) => message.metadata?.event_type === "thread_post",
      ),
    ).toHaveLength(1);
  });
});
```
