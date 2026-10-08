# Evals Spec

## Intent

Evals are the integration-style test layer for agent-facing behavior when model interpretation is part of the contract. Most suites run end-to-end Slack conversations. Isolated suites call one production model boundary.

There are four independently runnable suites:

1. **Integration** (`evals/integration/**`) — full agent/runtime runs for primary system functionality that should never regress. Failures are hard pass/fail.
2. **Behavioral** (domain folders under `evals/` except `integration/`, `guardian/`, and `router/`) — full agent/runtime runs that measure agent behavior. Rubrics allow valid variations. CI requires an 80% case pass rate, so a known product gap can stay visible as a failing case without blocking the suite.
3. **Guardian** (`evals/guardian/**`) — isolated decision snapshots scored only on `allow` / `ask` / `deny`. Failures are hard pass/fail.
4. **Router** (`evals/router/**`) — isolated turn route snapshots scored on exact model profile and reasoning level selections. Failures are hard pass/fail.

- Integration and behavioral cases run the real agent through the agent test fixture.
- Guardian and router cases use `describeEval()` with their own harness. They call one model boundary and do not run the agent.
- Behavioral and integration evals use normal core model configuration, including loaded environment overrides. Without overrides, they use the shared core defaults. Neither suite pins models or adds profiles.
- Router evals use the shared core profiles and configured fast model. Reasoning cases remove fixed profile levels to test the classifier; profile cases retain the defaults.

## Agent Test Fixture

Tests that run the agent use the agent test fixture in `src/fixture/`. Issue
#2001 has the full contract.

The agent is one unit. A test does not mock the model or any other part of
the agent. A test touches the product in three places only:

1. Inputs through app routes: `slackMention()` and `slackThreadMessage()` post
   signed Slack Events API webhooks, `webMessage()` posts to the conversations API,
   `heartbeat()` calls the heartbeat route, `githubWebhook()` posts a
   signed GitHub webhook to the GitHub plugin route, and `completeAuth()`
   calls the OAuth or MCP OAuth callback route.
2. Mocked third-party APIs: Slack and other providers through MSW.
3. What people and the model see: replies, tool calls, reactions, and turn
   states, read through Junior's reporting API.

```ts
import { describe, expect } from "vitest";
import { slackMention, reply } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Thread Continuity", () => {
  test("when asked about the prior turn, recall it", async ({ run }) => {
    const conversation = await run(slackMention("what did i just ask?"), {
      history: [slackMention("I need the budget by Friday."), reply("Got it.")],
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({ pass: ["Recalls the budget and Friday."] }),
    );
    expect(conversation.replies).toHaveLength(1);
  });
});
```

- `run()` starts a new Conversation on the test's agent. `continue()` sends
  the next input to the same Conversation. `fork()` calls the forks route.
- `agent(options)` creates the test's agent with `createApp()` options, such
  as `limits` or `slack.crossActorMidRunMode`. Without it, the agent uses the
  default options. Configure plugins as a host does:
  `agent({ plugins: defineJuniorPlugins([sentryPlugin()]) })`. Tests may
  import the public `@sentry/junior` API and plugin packages, but not runtime
  internals under `@/`.
- The default agent has no experimental feature, as in production. A test
  that needs one turns it on. For example, Junior replies to a thread message
  without a mention only with `agent({ experimental: { "passive-routing": true } })`.
- A suite is a Vitest project for one directory. It provides
  `agentOptionsModule`, a module whose default export is the default
  `createApp()` options of its tests, and it can set host environment such as
  `SKILL_DIRS`. Tests in a suite call `run()` without `agent()`.
  `agent(options)` replaces the suite defaults key by key.
- The `coding` suite has the GitHub and memory plugins and the coding skills.
  `src/suites/coding.ts` has its settings. Its integration evals are in
  `evals/integration/coding/`, and its behavioral evals are in `evals/coding/`.
  Put an eval that needs the GitHub plugin in this suite. Do not set up the
  plugin in the test.
- The `memory` suite has the memory plugin and no other plugin or skill.
  `src/suites/memory.ts` has its settings. Its evals are in `evals/memory/`.
- The `sentry` suite has the Sentry plugin. `src/suites/sentry.ts` has its
  settings. Its evals are in `evals/sentry/`.
- The `skills` suite has the skills in `fixtures/skills/`, the skills of the
  Agent Browser plugin, and two eval plugins with tools of the eval MCP
  server. `src/suites/skills.ts` has its settings. Its evals are in
  `evals/skills/`.
- The `auth` suite has two eval plugins and their skills: the MCP server of
  `eval-auth` needs OAuth, and the HTTP API of `eval-oauth` needs an OAuth
  token. `src/suites/auth.ts` has its settings. Its evals are in
  `evals/integration/auth/`. `global-setup.ts` registers the same plugins,
  because the eval egress process adds credentials to sandbox requests.
- A call returns when the agent is idle: the in-process queue is empty, and
  the work that turns started, such as titles and plugin tasks, is finished.
  A call fails when the agent is not idle within 60 seconds. The product
  delays some queued deliveries; for example, a watch delivery waits 30
  seconds for more events. The 60 seconds start when the last delivery is due.
- A channel `slackMention()` arrives as Slack sends it: an `app_mention` event
  without a channel type, then a `message` event with the same `ts` and the
  channel type. Slack does not fix the order, and Junior stores the first
  event. Junior then asks Slack for the channel type and learns that the
  channel is public.
- `slackMention()` and `slackThreadMessage()` take `files`, and `webMessage()`
  takes `images`. `file(name, mimeType, content)` is a file that a person uploaded.
  The Slack mock serves its download and lists it in the thread history.
  `unavailableFile(name, mimeType)` is a file whose download fails.
  `ticketScreenshotPng()` in `src/fixture/images.ts` is a real PNG that shows
  a ticket number. Only the pixels have the number, so a reply with
  `TICKET_NUMBER` proves that Junior read the image.
- `slackMention()` and `slackThreadMessage()` take `forwarded`, the text of a
  message that the person forwarded with their own message.
- `slackAppMessage(text)` is a message from another Slack app for `history`,
  such as an alert that starts the thread. It comes before the first input. Junior
  took no turn for it and stored nothing, so the message is in the Slack mock
  only, and a later turn reads it from Slack.
- Slack sends a forwarded message and the content of an app message outside
  the message text. The fixture builds those Slack shapes, so a test gives
  only the text.
- Plugin tasks run in process after each completed turn. For example, the
  memory plugin extracts memories from the turn before the call returns.
- `history` loads earlier turns as stored data. Loading never runs the agent.
  It writes the same rows as a real turn; `src/fixture/history.eval.ts` checks
  this against real turns. An input that addresses Junior without a reply is a
  turn that ended with `[[NO_REPLY]]`. `reply(text, { toolHistory })` adds the completed tool calls
  before that reply. The model sees them; people do not. `history`
  also accepts a recorded conversation from `src/fixture/recordings/`. Export
  one with `exportRecordedConversation()`.
- `onProgress` reacts to what the turn does: `model_request`,
  `tool_request`, or `reply`. Its `send(input)` posts an input while the turn
  waits, so the product decides whether it steers, waits, or stops the turn.
  `sendDuringFirstModelRequest(inputs)` in `src/fixture/progress.ts` sends
  inputs while the first model request waits.
- Insert functions in `src/fixture/insert.ts` write setup data through the
  product store functions. They never run turns. Add one when a test needs a
  new kind of setup data.
- `run(heartbeat())` returns the Conversation that a due automation started.
  Make an automation due with `insertScheduledAutomation({ due: true })`.
  `run(githubWebhook(...))` returns the Conversation that a matching
  `insertEventAutomation()` started. The agent needs the GitHub plugin. These
  Conversations take no further input.
- `conversation.continue(githubWebhook(...))` delivers the event to the
  watches of that Conversation. The agent can create the watch in an earlier
  turn, or `insertWatch({ conversation, ... })` stores one.
- A turn that needs authorization sends the person a private link and stays
  `started`. The link is in an ephemeral message, or in a normal message when
  the Conversation is a direct message.
  `conversation.continue(completeAuth(provider))` opens that link, the mocked
  provider redirects to the callback route of the app, and the call returns
  the resumed turn. A link in a channel message is not private, so the call
  fails.
- `insertCredential()` stores the OAuth credential that a Slack person has
  for a plugin. `expired: true` makes its next use refresh it.
  Credentials are in the state store, which tests share, so the fixture
  removes the credentials of a test when the test finishes.
- `insertMemory({ content })` stores a memory about a Slack person. The agent
  needs the memory plugin to recall it. `subjectType: "conversation"` stores a
  memory about the conversation. `visibility: "private"` stores a memory that
  only the person can recall.
- `readMemories()` in `src/fixture/memory.ts` returns the active memories
  that a Slack person can recall. It reads through the store of the memory
  plugin. A memory that Junior forgot is not in the list. Assert on the
  result in the eval, for example on `content`, `kind`, `scope`, and
  `subjectType`.
- When several evals need the same input, read, or assertion, add a shared
  helper to `src/fixture/`. Do not repeat the logic in each eval.
- Slack replies are the posts in the Slack thread, including posts that Junior
  does not store. A reply is the body that people see, without the footer.
  Each Conversation is read as the person who started it.
- Assert facts that do not depend on wording: reply counts, turn states, tool
  calls, and reactions. `completedToolCalls()` returns completed calls of one
  tool; `completedMcpToolCalls()` returns completed calls of one MCP tool.
  `toolCallsOf()` and `mcpToolCallsOf()` return calls in any state.
  `toolOutput()` parses a tool result. Do not assert on stored rows or
  runtime objects.
- Eval results put numeric agent-call usage in `usage.metadata.modelCalls`.
  Each entry comes from an `assistant_message` event in the reporting API.
  It has the model, event sequence, token counts, and cost when available.
  Loaded history and model calls outside agent history have no entry.
  `usage.metadata.modelTotals` has aggregate token counts and costs for
  recorded assistant calls by model. `usage.metadata.costUsd` sums those
  totals. `usage.metadata.auxiliaryCostUsd` has recorded routing and other
  non-assistant event costs. `usage.metadata.auxiliaryOperations` groups those
  costs by fixed Junior event kind. Other operation names stay in one group.
  Failed batches can have a cost without a stored observation. Optional
  `estimatedCostUsd` marks charges based on token rates instead of a Gateway
  bill. Keep estimated charges distinct from billed costs.
  `usage.metadata.gatewayModelCalls` has estimated
  costs and numeric token counts from Messages responses during fixture calls.
  This includes assistant calls, titles, and compaction summaries. Do not add
  it to `costUsd` without removing the assistant calls counted in both.
  Gateway calls on other endpoints have no per-call cache counters here.
  A missing counter means unknown, not zero.
  The fixture never copies message or tool content into these usage entries.
- `usage.metadata.distillation[conversationId]` records the number and cost of
  stored observations and the known cost of failed batches. It lists history
  replacements with their event sequence, input token estimates, expected
  calls, and price decision. It counts capacity and unclassified compaction
  events separately. It contains no observation text or replacement summary.
  Check `historyComplete` before treating a zero count or an empty replacement
  list as proof that none happened.
- `usage.metadata.distillationDecisions[conversationId]` copies fixed skip
  reasons and numeric estimates from diagnostic logs. Use them for diagnosis,
  not as a product behavior assertion. No source text enters this field.

Compare context cost on the same commit with
`JUNIOR_CONTEXT_DISTILLATION_ENABLED=false` and `true`. Use a full-runtime
case with completed Turns. Loaded `history` does not start the worker. Before
comparing cost, check that the enabled run wrote observations and replaced
history. Match the routed models and completed tasks across runs. Compare
assistant cost plus auxiliary cost, cache reads and writes, reply quality,
elapsed time, and repeated work. Repeat each setting. A run with no history
replacement does not measure the cost of using observations.
On a draft PR to `main`, the `trigger-context-cost-evals` label runs the
scoped-lookup coding case with the feature off and on at the same revision.
Both runs upload a `context-cost-*` result. The case uses Astra because a
later Turn can make observation work worthwhile at its current cache prices.
It uses four live Turns: diagnose a failed CI run, read a later CI artifact,
repair the scoped lookup, then recall an audit reference from an earlier CI
result. The reference is unique to the run and absent from the source tree.
Require a completed repair, passing focused test, exact reference, and honest
release note in both runs.
The older CI shards bring the first live Turn near the default 360k capacity
trigger. Require no capacity compaction in that Turn. Require a later capacity
compaction in the off run and observations with a `priced: true` history
replacement in the on run before using the pair as cost evidence. Re-run the
pair to check variation. The separate long CI continuity case routes Luna. At
the default context cap and current prices, its worker cannot pass the 20%
check. Keep an uneconomical skip as a valid price decision. Do not lower the
price check to make an eval activate.

The `context batch / probe` CI job sends one synthetic Gateway Batch. It
reports only its state and numeric cost. A pending result proves submission,
not completed Batch cost or quality. Re-run the job at the same revision to
check the same idempotency key. The paired `context cost / off` and `/ on`
jobs use direct observation calls. They do not measure Batch cost.

- Judge wording with the vitest-evals matcher:
  `await expect(conversation).toSatisfyJudge(RubricJudge, rubric({ pass, fail }))`.
  A call result is also the vitest-evals run of that call. `RubricJudge`
  scores the replies of the call and reads the earlier messages of the
  Conversation as context. `rubric()` adds the passing threshold. Other
  vitest-evals judges work the same way; pass `judgeHarness` from
  `src/fixture/judge.ts` to a judge that asks a model.

`scripts/check-test-architecture.mjs` enforces the fixture rules. Its baseline
in `scripts/test-architecture-baseline.json` lists the files that break each
rule today. Lower an entry when you fix a file. Do not add entries.

## Layer Boundaries

Testing taxonomy and layer contracts are defined in:

- `policies/testing.md`
- `packages/junior/tests/README.md`
- `policies/evals.md`

Quick mapping:

- `tests/integration/*`: Slack/runtime integration and HTTP contract tests.
- `evals/*`: Integration-style coverage for conversation-level agent behavior and quality scoring through the agent test fixture.
- `tests/unit/*` (or non-integration tests): isolated logic/invariant tests.

This separation is enforced by `pnpm lint`.

## What Is In Scope

- Conversation-level behavior under realistic thread/message flows.
- Tool use and output behavior as observed by the runtime.
- Slack-visible metadata exposed by the runtime and the fixture.

Not in scope:

- Isolated unit behavior (belongs in unit tests).
- Low-level Slack HTTP payload contract checks (belongs in integration tests).

## Sources Of Truth

- Integration system cases: `evals/integration/`
  - primary runtime/system correctness that must never regress (hard pass/fail)
  - conversation delivery, mention/channel routing limits, lifecycle, OAuth plumbing, subscription stop-watch, event-automation contracts, and scheduler create/credential/management contracts
- Behavioral conversation cases: `evals/conversation/`
  - participation, actor attribution, continuity, storage, and output shape
- Behavioral agent cases: `evals/agent/`
  - research reply shape and Slack user status, on the default agent
- Behavioral skills suite cases: `evals/skills/`
  - skill invocation and routing, MCP providers, and Guardian action review
- Behavioral coding suite cases: `evals/coding/`
  - file tools, GitHub skill workflows, watch intent, summary quality, a fix after a failed check, and a mention during a watch delivery, with the GitHub plugin
- Behavioral feature cases:
  - `evals/memory/`
  - `evals/scheduler/` (due-occurrence delivery quality)
  - `evals/sentry/`
- Isolated Guardian decisions: `evals/guardian/`
  - exact `ToolActionProposal` snapshots scored only on `allow` / `ask` / `deny`
- Isolated turn routes: `evals/router/`
  - exact model profile and reasoning level selections
- Agent test fixture: `src/fixture/`
- Guardian harness: `src/guardian-harness.ts`
- Router harness: `src/router-harness.ts`

The ticket lookup in `evals/conversation/actors.eval.ts` defines an
`eval-tracker` plugin for the eval MCP server. The server supplies two tickets
with different causes and exposes a write operation. The case requires a
successful search and rejects writes. An ambient offer from another person is
not permission to change a ticket.

The output cases accept labeled links, as the Slack output contract does.
Watch summaries may use tool discovery and read-only inspection; they do not
require a fixed tool sequence. The failed-check case loads GitHub with fixture
credentials. Host and Sandbox HTTP reads use the same open PR, failed check,
and log fixtures in `junior-testing/src/http/github-checks.ts`.
Reply-count checks include file-only replies. A reaction is not a thread reply.

## Global Setup

Suite global setup, snapshot warmup, and egress use the same plugin
registrations so dependencies and credentials match. Worker and global setup
each install the AI Gateway transport timeouts in their own process. Quick
Tunnel startup uses normal system DNS and retains failed attempts and logs.
Global setup reports the Postgres, egress, and snapshot phases before cases
start. Egress teardown stops the tunnel and closes its remaining HTTP
connections.

## Web Pages And Search

- The fixture replays the requests that the `webFetch` tool sends.
  `src/fixture/web.ts` records each response under
  `.vitest-evals/recordings/webFetch/` and answers later requests for the same
  URL from the recording. A redirect is its own recording.
- The fixture always mocks the search provider of `webSearch`. No test turns
  the mock on or off, and no search reaches the real provider. A search finds
  nothing by default. `mockWebSearchResults()` from `src/fixture/web.ts` sets
  the results for one test.
- Use `pnpm evals:record` to record the pages again.
- Git ignores new recordings. Add the ones that an eval needs with
  `git add -f`. Review them for stale fetches and secret-like values before
  you commit.

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

- On pull requests, four independent workflows use the display name `Evals`. Each has its own concurrency group and reports its own suite:
  - `evals-behavioral.yml`: Slack/agent evals (`behavioral / shard *` + `behavioral / report` → `behavioral / score` Check Run)
  - `evals-integration.yml`: system evals (`integration / shard *`)
  - `evals-guardian.yml`: isolated Guardian snapshots (`guardian / run`)
  - `evals-router.yml`: isolated turn route snapshots (`router / run`)
- Suite labels follow `trigger-evals-[domain]`:
  - `trigger-evals` starts all suites
  - `trigger-evals-behavioral`, `trigger-evals-integration`, `trigger-evals-guardian`, and `trigger-evals-router` start one suite
- Behavioral and integration evals require both gateway and sandbox secrets. Guardian and Router only need gateway credentials.
- Adding a trigger label fires immediately; unrelated labels do not.
- Behavioral path triggers cover domain folders under `evals/{agent,coding,conversation,memory,scheduler,sentry,skills}/` and shared harness/config files under `packages/junior-evals/`.
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

- Write cases that run the agent with the agent test fixture (see **Agent Test Fixture**).
- Put full-runtime integration cases that must never regress under `evals/integration/**`. Prefer deterministic assertions; keep a rubric only when the case still needs light quality scoring.
- Put behavioral cases under `evals/conversation/`, `evals/agent/`, or `evals/<feature>/`. Put a case that needs the plugins or skills of a suite in the directory of that suite.
- Add isolated Guardian decision snapshots under `evals/guardian/` using `describeEval()` with `guardianEvals`. Feed exact `ToolActionProposal` objects and assert only the expected `allow` / `ask` / `deny` decision.
- Add isolated turn route snapshots under `evals/router/` using `describeEval()` with `routerEvals`. Feed realistic task inputs and assert the exact model profile and reasoning level.
- Keep each case focused on one primary behavior.
- Put semantic, model-dependent expectations in a rubric for `RubricJudge`.
- Put deterministic boundary expectations in normal Vitest assertions against the call result: `replies`, `toolCalls`, `reactions`, `files`, `compactions`, and `turns`.
- When an eval judges nondeterministic visible output, write the rubric with `rubric({ pass, fail })`.
- Let the eval test name describe the scenario and expected outcome.
- `pass` should list observable pass conditions.
- `fail` should list forbidden outputs or failure conditions.
- Do not write judge criteria as one dense paragraph.
- Let the `describe()` block own the behavior area. The file path and `describe()` context already provide scope.
- Each eval name should only state the specific scenario and outcome.
- Prefer `when <trigger>, <outcome>` over vague labels like `continuity: remembers prior turn context`.
- Keep user prompts natural when a rubric or judge scores the outcome. They should read like plausible user requests, not scripted implementation instructions.
- A case that only asserts a deterministic outcome, such as turn routing or delivery, may use short manufactured inputs. Fewer model calls keep it fast.
- Do not tell the assistant which exact internal command, tool, skill-loading step, or transport sequence to use unless that exact surface is what the user would naturally say and is the behavior under evaluation.
- If an eval only passes when the prompt prescribes internal mechanics, the eval is invalid and the product behavior is not adequately covered.

Do not do these in eval files:

- Do not import `@/chat/slack/*` directly.
- Do not use MSW Slack helpers (`queueSlackApiResponse`, `getCapturedSlackApiCalls`, `queueSlackApiError`, `queueSlackRateLimit`).
- Do not validate raw Slack Web API request payload shapes from evals.
- Do not invent parallel transcript, event-log, or tool-call schemas for assertions. If the call result is insufficient, improve the fixture first.
- Do not validate implementation internals (exact tool names, sandbox IDs, or other non-user-visible details) unless the scenario explicitly evaluates those surfaces.

## File Organization

Organize files by suite policy first, then by the user-visible area they exercise:

- `evals/integration/`: strict full-runtime integration cases (hard pass/fail).
- `evals/conversation/`, `evals/agent/`, `evals/<feature>/`: agent-behavior cases (score-gated in CI). A suite directory, such as `evals/coding/` or `evals/skills/`, has the cases that need its plugins and skills.
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
- Use `conversation.toolCalls` when tool/provider evidence proves behavior at a real boundary, such as source grounding, mutation safety, provider routing, or auth sequencing.

Avoid:

- Criteria tied to exact internal tool call names (`bash`, etc.) when user-visible behavior is what matters.
- User prompts that prescribe exact internal commands or tool choices just to force the desired path.
- Prompts that can hit random external URLs or mutate real provider resources for a behavior that can be tested with fake references.
- Cases that only validate mocks or internal state transitions without conversational context.

## Minimal Case

```typescript
import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Routing", () => {
  test("when explicitly mentioned, post one direct reply", async ({ run }) => {
    const conversation = await run(slackMention("Summarize this"));

    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({ pass: ["The assistant answers the user's summary request."] }),
    );
    expect(conversation.replies).toHaveLength(1);
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
CI stops a stalled shard at the 30-minute job limit. Each call also joins the
title and plugin tasks of its turns.

Gateway header and body-idle limits do not replace request cancellation.
Judges and task titles receive the caller's signal; reply budgets stay unchanged.
