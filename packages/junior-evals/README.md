# Evals Spec

## Intent

Evals are the integration-style test layer for agent-facing behavior when model interpretation is part of the contract. Most suites run end-to-end Slack conversations. Isolated suites call one production model boundary.

There are four independently runnable suites:

1. **Integration** (`evals/integration/**`) — full agent/runtime runs for primary system functionality that should never regress. Failures are hard pass/fail.
2. **Behavioral** (domain folders under `evals/` except `integration/`, `guardian/`, and `router/`) — full agent/runtime runs that measure agent behavior. Rubrics allow valid variations. CI requires an 80% case pass rate, so a known product gap can stay visible as a failing case without blocking the suite.
3. **Guardian** (`evals/guardian/**`) — isolated decision snapshots scored only on `allow` / `ask` / `deny`. Failures are hard pass/fail.
4. **Router** (`evals/router/**`) — isolated turn route snapshots scored on exact model profile and reasoning level selections. Failures are hard pass/fail.

- We define conversation cases inline in TypeScript using `describeEval()` and the shared `slackEvals` harness options.
- We run the real runtime/harness against those fixtures.
- We score outcomes against the normalized `vitest-evals` session surface, backed by Junior's Pi client. The eval runtime pins standard to `xai/grok-4.5`, auxiliary work to `anthropic/claude-haiku-4.5`, Guardian review to `openai/gpt-6-luna`, and handoff continuation to `openai/gpt-5.6-sol`, so model-specific behavior stays reproducible.

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

- Integration system cases: `evals/integration/`
  - primary runtime/system correctness that must never regress (hard pass/fail)
  - conversation delivery, mention/channel routing limits, lifecycle, OAuth plumbing, subscription stop-watch, event-automation contracts, and scheduler create/credential/management contracts
- Behavioral conversation cases: `evals/conversation/`
  - participation, actor attribution, continuity, storage, output shape, and model-variable routing judgment
- Behavioral agent cases: `evals/agent/`
  - skills, providers, research, files, subscription intent/summary quality, and skill routing
- Behavioral feature cases:
  - `evals/memory/`
  - `evals/scheduler/` (due-occurrence delivery quality)
  - `evals/github/`
  - `evals/sentry/`
- Isolated Guardian decisions: `evals/guardian/`
  - exact `ToolActionProposal` snapshots scored only on `allow` / `ask` / `deny`
- Isolated turn routes: `evals/router/`
  - exact model profile and reasoning level selections
- Helpers and event builders: `src/helpers.ts`
- Guardian harness: `src/guardian-harness.ts`
- Router harness: `src/router-harness.ts`
- Harness/runtime adapter: `src/behavior-harness.ts` (scenario entry) with its concerns split under `src/harness/`: types, environment, auth fixtures, threads, Slack artifacts, replay tools, runtime services, event processing, and plugin tasks

The ticket lookup in `evals/conversation/actors.eval.ts` uses the `eval-tracker`
MCP fixture. It supplies two tickets with different causes and exposes a write
operation. The case requires a successful search and rejects writes. An ambient
offer from another person is not permission to change a ticket.

The output cases accept labeled links, as the Slack output contract does.
Watch summaries may use tool discovery and read-only inspection; they do not
require a fixed tool sequence. The failed-check case loads GitHub with fixture
credentials. Host and Sandbox HTTP reads use the same open PR, failed check,
and log fixtures in `junior-testing/src/http/github-checks.ts`.
Reply-count checks include file-only replies. A reaction is not a thread reply.

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
- The Slack eval harness reads SDK and HTTP thread replies from the shared Slack fixture once, before the next inbound message. Other Slack API side effects may be collected afterward. The rubric judge receives user-visible text, visible Slack author names, and attachment labels from normalized user and assistant messages. Tool calls, artifacts, logs, and other runtime observations stay outside its prompt.
- Omit `criteria` for deterministic-only cases. Use shared typed selectors plus explicit assertions for tool calls, reactions, attachments, persistence, and delivery side effects; the rubric judge is reserved for nondeterministic visible reply quality.
- When the eval boundary is Junior's Pi agent or needs an ordered full-turn transcript, prefer `@vitest-evals/harness-pi-ai` primitives instead of rebuilding transcript capture locally. The Pi harness already owns normalized `session.messages`, `toolCalls(result.session)`, artifacts, traces, replay, and judge context.
- Do not assert against logs, spans, or status telemetry for product behavior. Use `vitest-evals` session/tool/artifact primitives for behavior contracts; reserve traces/spans for instrumentation tests or diagnostics.

A scenario controls three things, and nothing else:

1. **Agent config.** The runtime the scenario instantiates: plugin packages and fixture dirs, skill dirs, credentials, env, and runtime service overrides. Production sets the same things at startup, so a scenario that needs different behavior configures a different runtime instead of reaching into a running one.
2. **Preloaded history.** Prior turns written through the runtime's own stores before the first event, with `history: [mention(...), reply(...)]`. No agent runs for them. The visible thread transcript, durable agent history, and conversation messages all exist as a completed turn would have left them, and a thread Junior replied in stays subscribed.
3. **Mocked third-party APIs.** Slack, provider HTTP, MCP fixtures, and image generation through the shared MSW handlers and fixtures.

Do not add a knob that writes runtime state directly, scripts the model, or replaces a Junior-owned module. `active_turn_compaction` is the one remaining exception: the active-turn compactor takes no trigger override, so it still seeds a paused turn record.

Harness override knobs (in `EvalOverrides`):

- `active_turn_compaction`: seeds an active-turn compaction boundary so an eval can exercise model continuation without manufacturing oversized tool output.
- `auto_complete_mcp_oauth`: after our app genuinely starts an MCP OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `auto_complete_oauth`: after our app genuinely starts a generic OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `credential_providers`: seed normal provider credentials for the listed providers. GitHub uses dummy GitHub App env vars plus an intercepted installation-token exchange; Sentry uses the normal OAuth token store.
- `mock_image_generation`: stub the image-generation HTTP response with a valid image payload while still exercising the real attachment path.
- `plugin_dirs`: load plugin fixtures from eval-local directories without adding workspace packages.
- `reply_timeout_ms`: lower the per-reply harness timeout for a specific scenario. It cannot exceed 60 seconds. Harness tests use it; live evals keep the default.
- `turn_timeout_ms`: shorten the agent turn deadline for every run slice, below the 60-second reply budget. The real runtime handles the deadline: it aborts in-flight tools, records the boundary, and resumes the turn. Pair it with a fixture tool that stalls, such as the eval-operation `release-push` whose first call lands remotely but stalls past the deadline.

These knobs work by overriding services on the eval-local runtime instance. They must not reintroduce mutable global runtime behavior seams.

The queue waits for each delivery's due time before starting the worker. The
60-second reply budget starts after that wait. Scenarios, snapshot warmup, and
egress use the same plugin registrations so dependencies and credentials match.

Failed runs keep their partial session in the report and still fail the case.
`src/eval-result.ts` converts both successful and failed results. Worker and global
setup each install the AI Gateway transport timeouts in their own process. Quick Tunnel
startup uses normal system DNS and retains failed attempts and logs. Global
setup reports the Postgres, egress, and snapshot phases before cases start.
Egress teardown stops the tunnel and closes its remaining HTTP connections.

Tool replay:

- `webFetch` and `webSearch` are wrapped with `vitest-evals/replay` in the eval harness. Use `pnpm evals:record` to force fresh recordings under `.vitest-evals/recordings`.
- Keep committed recordings minimal and source-specific. Regenerate them from the evals that need replay, then review for stale exploratory fetches and secret-like values before committing.

## Running

- `pnpm evals` / `pnpm evals:behavioral`: Run the behavioral suite
- `pnpm evals:integration`: Run the integration suite
- `pnpm evals:guardian`: Run isolated Guardian decision snapshots
- `pnpm evals:router`: Run isolated turn route snapshots
- `pnpm --filter @sentry/junior-evals evals:behavioral`: Run behavioral from any directory
- `pnpm --filter @sentry/junior-evals evals:integration`: Run integration from any directory
- `pnpm --filter @sentry/junior-evals evals:guardian`: Run Guardian from any directory
- `pnpm --filter @sentry/junior-evals evals:router`: Run the turn router from any directory
- `pnpm --filter @sentry/junior-evals evals:behavioral evals/sentry/skills.eval.ts`: Run one behavioral file
- `pnpm --filter @sentry/junior-evals evals:integration evals/integration/conversation/actions.eval.ts`: Run one integration file
- `pnpm --filter @sentry/junior-evals evals:guardian evals/guardian/action-review.eval.ts -t "deny"`: Run one Guardian case
- `pnpm --filter @sentry/junior-evals evals:router evals/router/reasoning.eval.ts -t "code change"`: Run one turn router case
- `pnpm --filter @sentry/junior-evals evals:behavioral --shard=1/4`: Run one of the four CI behavioral shards

Pass eval file paths, `-t` filters, and shard options directly after the suite script. Do not use `pnpm exec vitest` directly, and do not insert `--` before eval arguments.

## Optional CI Runs

- On pull requests, four independent workflows run and report their own suites:
  - `Behavioral evals`: Slack/agent evals (`behavioral / shard *` + `behavioral / report` → `behavioral / score` Check Run)
  - `Integration evals`: system evals (`integration / shard *`)
  - `Guardian evals`: isolated Guardian snapshots (`guardian / run`)
  - `Router evals`: isolated turn route snapshots (`router / run`)
- Suite labels follow `trigger-evals-[domain]`:
  - `trigger-evals` starts all suites
  - `trigger-evals-behavioral`, `trigger-evals-integration`, `trigger-evals-guardian`, and `trigger-evals-router` start one suite
- Behavioral and integration evals require both gateway and sandbox secrets. Guardian and Router only need gateway credentials.
- Adding a trigger label fires immediately; unrelated labels do not.
- Behavioral path triggers cover domain folders under `evals/{agent,conversation,github,memory,scheduler,sentry}/` and shared harness/config files under `packages/junior-evals/`.
- Integration path triggers cover `evals/integration/**`, the integration config, and shared harness files under `packages/junior-evals/`.
- Guardian path triggers cover `evals/guardian/**`, the Guardian harness/config under `packages/junior-evals/`, and `packages/junior/src/chat/services/guardian-action-policy.ts`.
- Router path triggers cover `evals/router/**`, the Router harness/config under `packages/junior-evals/`, and the turn router source under `packages/junior/src/chat/`.
- Other product source under `packages/junior/src/**` does not auto-run evals; use a `trigger-evals*` label for that.
- Behavioral shards still fail individual cases under the per-case judge threshold (`0.75`), but the workflow no longer fails the shard job on those case failures alone. Each behavioral shard, Guardian job, and Router job publishes its own `vitest-evals` job summary (pass rate, scores, quality misses).
- After all behavioral shards finish, `behavioral / report` combines results, writes the aggregate job summary, and publishes a `behavioral / score` Check Run. The Check Run title carries the case pass rate and the required 80% floor. When that check publishes, the report step soft-fails so the Check Run owns green/red instead of canned job failure text.
- The behavioral floor is `EVAL_MIN_PASS_RATE=0.8`. A failing case still names a product gap; the floor keeps the check meaningful for regressions while known gaps are open. `vitest-evals@0.16` owns the aggregate gate math. Missing or empty shard reports are hard failures, not successful runs. Agent execution errors fail the scenario before rubric judging, even if the runtime posted a safe failure reply.
- Integration cases fail the `integration / shard *` jobs hard on any miss. They do not use the aggregate pass-rate floor.
- Guardian cases assert exact `allow` / `ask` / `deny` decisions and fail the `guardian / run` job hard on mismatch. They do not use the aggregate pass-rate floor.
- Router cases assert exact model profile and reasoning level selections and fail the `router / run` job hard on mismatch. They do not use the aggregate pass-rate floor.
- The simplest Gateway and Sandbox setup is `VERCEL_OIDC_TOKEN` alone.
- The fallback CI setup is `AI_GATEWAY_API_KEY` plus `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
- Behavioral and integration global setup starts one Cloudflare Quick Tunnel for the suite so Vercel Sandbox can reach the eval egress proxy. Transient tunnel allocation failures retry up to five times with backoff. Local runs require `cloudflared` on `PATH`; CI verifies the pinned official binary's SHA-256 checksum before running it.
- Behavioral and integration state always uses a loopback Redis. Local runs default to `redis://127.0.0.1:6382`; CI sets `JUNIOR_EVAL_REDIS_URL` for its Redis service.
- Set the GitHub Actions repository secret `SENTRY_EVALS_API_KEY` to upload results to `evals.sentry.dev`. Each suite uploads one run after execution, with all shards combined. Existing score gates and artifacts stay in place. Without the key, uploads are skipped.
- Setup details for GitHub Actions live in `evals/github-actions.md`.

Behavioral and integration evals require real Vercel Sandbox access and public Quick Tunnel connectivity. If either bootstrap fails, the eval fails immediately with no local fallback path. Guardian and Router evals only need AI Gateway access.

## Authoring Rules

- Put full-runtime integration cases that must never regress under `evals/integration/**` using `describeEval()` with `slackEvals`. Prefer deterministic assertions; keep criteria only when the case still needs light quality scoring.
- Put behavioral cases under `evals/conversation/`, `evals/agent/`, or `evals/<feature>/` using `describeEval()` with `slackEvals`.
- Add isolated Guardian decision snapshots under `evals/guardian/` using `describeEval()` with `guardianEvals`. Feed exact `ToolActionProposal` objects and assert only the expected `allow` / `ask` / `deny` decision.
- Add isolated turn route snapshots under `evals/router/` using `describeEval()` with `routerEvals`. Feed realistic task inputs and assert the exact model profile and reasoning level.
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
- `evals/conversation/`, `evals/agent/`, `evals/<feature>/`: agent-behavior cases (score-gated in CI).
- `evals/guardian/`: isolated Guardian decision snapshots (no main agent; hard pass/fail).
- `evals/router/`: isolated turn route snapshots (no main agent; hard pass/fail).
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

## Cleanup and CI

CI runs the harness tests once, without live credentials or a tunnel. Live eval
jobs select shared sources, fixtures, workflow and dependency changes.
Runtime-only changes still require the eval labels.

Global setup warms the base, GitHub, and Sentry snapshots once per shard.
The last setup file joins case work before MSW and database cleanup. This hook
has no separate timeout: late cleanup must not change the next case's state.
CI stops a stalled shard at the 30-minute job limit. Scenarios also join title
and plugin tasks. Failed runs retain their transcript, including cleanup errors.

Gateway header and body-idle limits do not replace request cancellation.
Judges and task titles receive the caller's signal; reply budgets stay unchanged.

Remove `patches/@earendil-works__pi-ai@0.85.1.patch` when the pinned SDK handles
capacity errors. It uses the existing retry budget and preserves quota exclusions.
