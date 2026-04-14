# Slack Streaming Investigation

Date: 2026-04-13
Status: Archive note, non-normative

## Scope

Investigate every code path Junior uses to push visible output into Slack thread replies, with emphasis on streamed assistant replies, status/progress updates, resumed turns, long-output handling, and partial/truncated reply behavior.

## Evidence Reviewed

- GitHub issues:
  - `getsentry/junior#187`
  - `getsentry/junior#97`
- Runtime and delivery code:
  - `packages/junior/src/chat/runtime/reply-executor.ts`
  - `packages/junior/src/chat/runtime/slack-runtime.ts`
  - `packages/junior/src/chat/runtime/progress-reporter.ts`
  - `packages/junior/src/chat/runtime/assistant-status.ts`
  - `packages/junior/src/chat/runtime/turn.ts`
  - `packages/junior/src/chat/services/reply-delivery-plan.ts`
  - `packages/junior/src/chat/slack/output.ts`
  - `packages/junior/src/handlers/oauth-resume.ts`
  - `packages/junior/src/handlers/turn-resume.ts`
  - `packages/junior/src/handlers/mcp-oauth-callback.ts`
- Relevant dependency sources:
  - `packages/junior/node_modules/chat/dist/index.js`
  - `packages/junior/node_modules/@chat-adapter/slack/dist/index.js`
  - `packages/junior/node_modules/@slack/web-api/dist/chat-stream.js`
  - `packages/junior/node_modules/@slack/web-api/dist/WebClient.js`
- Relevant tests:
  - `packages/junior/tests/integration/slack/streaming-reply-behavior.test.ts`
  - `packages/junior/tests/integration/slack/message-changed-behavior.test.ts`
  - `packages/junior/tests/integration/oauth-resume-slack.test.ts`
  - `packages/junior/tests/unit/slack/bot-handlers.test.ts`
  - `packages/junior/tests/unit/misc/output.test.ts`
  - `packages/junior-evals/evals/core/lifecycle-and-resilience.eval.ts`
- Targeted verification run:
  - `pnpm --filter @sentry/junior exec vitest run tests/integration/slack/streaming-reply-behavior.test.ts tests/integration/slack/message-changed-behavior.test.ts tests/integration/oauth-resume-slack.test.ts`
  - Result: `3` files passed, `10` tests passed

## Outbound Slack Delivery Paths

Junior currently uses three separate outbound mechanisms for user-visible Slack behavior:

1. Native streamed thread replies
   - `reply-executor.ts` calls `thread.post(AsyncIterable<string>)`
   - `chat` routes this through `ThreadImpl.handleStream(...)`
   - `@chat-adapter/slack` implements native streaming via `client.chatStream(...)`
   - Slack Web API methods used: `chat.startStream`, `chat.appendStream`, `chat.stopStream`

2. Assistant status sideband updates
   - `progress-reporter.ts` drives `assistant.threads.setStatus`
   - Used during normal turns and resume flows
   - This is independent from the visible reply stream

3. Non-stream final posts
   - OAuth resume, MCP OAuth callback, and timeout resume handlers use raw `chat.postMessage`
   - These flows do not use the native stream path at all

Files are delivered separately via `files.uploadV2`, usually as a follow-up after a streamed reply has already started.

## Confirmed Findings

### 1. Native Slack streaming is gated by three separate buffers

This is the single biggest reason the current UX feels inconsistent.

#### Gate A: Junior-level ack suppression

`reply-executor.ts` buffers early deltas in `pendingStreamText` and refuses to start the stream while the text still looks like a short acknowledgment prefix such as `ok`, `okay`, `done`, or `got it`.

This gate is small, but it delays the first visible post for responses that begin with brief acknowledgment text.

#### Gate B: Chat SDK append-only markdown gating

`chat` uses `StreamingMarkdownRenderer.getCommittableText()` for Slack native streams.

That renderer withholds:

- incomplete trailing lines
- text inside unclosed inline markdown states
- potential table headers until a separator arrives

For ordinary prose without a newline, the committable text stays empty.

A direct local check against the dependency confirmed:

- after pushing `"Hello "`, committable text is `""`
- after pushing `"world"`, committable text is still `""`
- only after a newline does the first committable prefix appear

So a normal sentence-first reply does not visibly stream until a newline or stream completion.

#### Gate C: Slack SDK `ChatStreamer` 256-character buffer

Even after `@chat-adapter/slack` decides to append markdown, Slack's own Node SDK buffers `markdown_text` until `256` characters by default before it sends `chat.startStream` or `chat.appendStream`.

Source: `@slack/web-api/dist/chat-stream.js` and `WebClient.js`.

Consequences:

- short replies often do not visibly stream at all
- longer replies may not start until well after the model has emitted text
- the app can be "streaming" locally while Slack still has nothing visible

### 2. `thread.post(asyncIterable)` is not equivalent to user-visible incremental streaming in practice

The current stack gives us an `AsyncIterable<string>` contract locally, but that does not guarantee prompt visible output in Slack.

This matters because the app code assumes "stream started" means "user is seeing streamed text," which is not true under the current dependency behavior.

### 3. Existing tests mostly verify eventual delivery, not perceived latency or mid-stream behavior

Coverage is weak in the exact area where the incidents are happening.

Current gaps:

- `createTestThread()` in the Slack harness eagerly drains async iterables into final strings, so most tests cannot catch real Slack stream lifecycle bugs.
- `streaming-reply-behavior.test.ts` proves we pass an async iterable into `thread.post`, but it does not exercise the actual Slack adapter or Web API stream sequence.
- `message-changed-behavior.test.ts` is the main real adapter coverage, and it currently expects a short `"Hello world"` reply to use only `chat.startStream` plus `chat.stopStream`, with no `chat.appendStream`.

That expectation effectively codifies the current buffered behavior for short replies.

No test today asserts any of the following:

- first visible stream update arrives before completion
- single-line prose streams before a newline
- `chat.appendStream` happens during a realistic long reply
- long replies overflow intentionally instead of depending on Slack behavior
- stream transport failures do not produce confusing partial replies

### 4. Long-output policy is prompt-only and not enforced in code

This is the main architectural reason `#187` is plausible.

Facts:

- `slackOutputPolicy.maxInlineChars` is `2200`
- `slackOutputPolicy.maxInlineLines` is `45`
- those limits are inserted into the system prompt only
- `buildSlackOutputMessage()` does not enforce them
- `packages/junior/tests/unit/misc/output.test.ts` explicitly asserts that long content stays inline by default

This is worse for streamed replies:

- the native stream path does not call `buildSlackOutputMessage()` at all
- streamed text goes straight from `onTextDelta` into `thread.post(asyncIterable)`

So even if `buildSlackOutputMessage()` were hardened later, the current stream path would still bypass it unless the runtime also changes.

### 5. Resume/OAuth/timeout flows bypass the stream path and use a different Slack contract

Normal turns use:

- `chat.startStream`
- `chat.appendStream`
- `chat.stopStream`

Resume flows use:

- `chat.postMessage`

That means Slack behavior differs by execution path:

- different visible latency
- different truncation/limit semantics
- different error handling
- no shared overflow policy

Any fix that only touches `thread.post(asyncIterable)` will leave resumed turns inconsistent.

### 6. Partial provider failures are intentionally surfaced as plain assistant text with no user-visible interruption marker

This is a distinct, confirmed cause of "reply cut off mid-sentence."

Current behavior:

- if the agent/provider emits partial text and then ends with `provider_error`
- `buildTurnResult()` still returns the partial text as the assistant reply
- `reply-executor.ts` logs `agent_turn_provider_error`
- but the partial text is still posted to Slack as the final visible reply
- no "[interrupted]" suffix, no continuation marker, no fallback error reply

This is not accidental. It is locked in by:

- `packages/junior/tests/unit/slack/bot-handlers.test.ts`
- `packages/junior-evals/evals/core/lifecycle-and-resilience.eval.ts`

So a mid-sentence reply in Slack can come from provider failure even when Slack itself never truncated anything.

### 7. Slack transport warnings and partial-success cases are not surfaced through repository-owned observability

Slack WebClient logs `response_metadata.warnings` through its own logger.

Junior does not inspect or promote those warnings into repo-standard logs/spans for reply delivery.

Separately, Slack's own docs for `chat.startStream`, `chat.appendStream`, and `chat.stopStream` explicitly note that `fatal_error` and `internal_error` may occur after some aspect of the operation already succeeded.

Current reply handling treats stream post failure as a hard exception and may then send a fallback error reply, which risks user-visible combinations like:

- partial streamed content
- followed by a generic fallback error reply

That transport failure mode is not covered by current tests.

### 8. Stream transport does not use Junior's Slack retry wrapper

Our first-party Slack helpers (`withSlackRetries`) cover canvases, file uploads, reactions, history, and similar operations.

The stream path does not use that wrapper. It relies on dependency behavior instead.

This means:

- retry policy is inconsistent across Slack operations
- logging shape is inconsistent
- stream-specific failures are harder to correlate with the rest of our Slack operational surface

### 9. `assistant.threads.setStatus` is separate from the visible reply stream, which creates split-brain UX

The current design uses:

- status sideband for progress
- stream API for final text

This is workable, but it means "users see activity" and "users see reply text" are not the same thing.

When the stream path stalls behind the three buffers above, status updates may continue to rotate while no message text appears, making the transport feel broken even though the turn is still running.

### 10. Lower-confidence race: initial status update is fire-and-forget

`progress.start()` does not await the first `setStatus` call.

That means on a fast turn, the final reply can be posted before the first status request finishes, after which the delayed status request may still land and then be cleared by a later explicit clear.

I did not reproduce this end-to-end, so treat it as a lower-confidence risk, not a confirmed incident driver.

## What The Existing Issues Get Right And Wrong

### `#97` is directionally right but stale

The issue correctly identified that early stream visibility was being delayed by buffering before Slack saw content.

However, the specific implementation named there (`createNormalizingStream`) no longer exists in the current tree.

The same class of bug still exists, but it now lives in dependency code:

- `chat` append-only committable-text buffering
- Slack SDK `ChatStreamer` buffering

### `#187` is plausible but not yet proven to be solely a Slack character-limit problem

The codebase supports at least three plausible explanations for a mid-sentence cutoff:

1. Slack-side truncation or limits on a non-streamed post
2. stream-path overflow with no explicit continuation strategy
3. provider failure after partial text, which we intentionally show without a visible error marker

So the issue hypothesis should not be treated as sufficient root cause by itself.

## Positive Findings

Not everything in this area is broken.

- `message_changed` synthetic mention handling preserves `team_id` so Slack streaming still gets `recipient_team_id`
- file uploads are correctly posted after streamed replies when streaming has already started
- queue/thread normalization work appears deliberate and separate from the current transport issues

## Most Likely Root Causes Behind The Reported Symptoms

If I had to rank the highest-probability causes of current user-visible oddness:

1. Native stream startup is delayed by the combined ack gate, append-only markdown gate, and 256-character Slack SDK buffer.
2. Long replies have no runtime-enforced overflow strategy, despite prompt-level limits.
3. Partial provider failures are intentionally surfaced as final visible replies with no interruption marker.
4. Resume/OAuth paths use `chat.postMessage`, so their behavior diverges from normal streamed turns.

## Recommended Remediation Sequence

### 1. Pick one explicit product contract for Slack replies

Do not keep layering heuristics onto the current system without first deciding the intended behavior.

The two viable product contracts are:

- true incremental streaming in Slack
- status-first UX plus final reply posting, with no promise of token-level streaming

Right now the code claims the first while often behaving like the second.

### 2. Land transport-behavior integration tests before changing code

Add real adapter + MSW tests for:

- short single-line prose reply
- long single-line prose reply with no newline
- multi-paragraph reply that should require at least one `chat.appendStream`
- stream transport failure after partial success
- long reply overflow behavior
- provider error after partial text
- resume-flow long reply behavior

These should assert Slack HTTP contract and user-visible outcome, not just `thread.post(...)` usage.

### 3. Enforce overflow in runtime code, not only in the prompt

The app needs one shared output policy across:

- streamed normal turns
- non-streamed normal turns
- OAuth resume
- timeout resume
- MCP callback resume

At minimum:

- choose a hard inline threshold
- stop relying on model compliance alone
- when the threshold is exceeded, switch to an intentional continuation surface

Candidate continuation surfaces:

- Slack canvas plus short thread summary
- multi-message continuation in-thread with an explicit marker

### 4. Change how provider-error partial text is surfaced

Current behavior is too ambiguous.

At minimum:

- do not show interrupted partial text as if it were a completed answer

Reasonable options:

- append an interruption suffix
- post a short follow-up marker such as "response interrupted"
- fall back to a structured continuation strategy

### 5. Fix or replace the current native stream startup behavior

If we keep native streaming, the current dependency behavior is not good enough.

We need one of:

- an upstream/local patch to `chat` and/or `@chat-adapter/slack`
- a wrapper that exposes a smaller `buffer_size`
- a more monotonic initial append strategy that does not wait for newline-complete prose

Important constraint:

- do not reintroduce custom `chat.update` loops as the long-term Slack transport architecture unless we intentionally abandon native streaming

### 6. Unify observability for Slack delivery failures and warnings

Promote transport warnings and stream failure details into repo-standard logs/spans so operators can answer:

- was the reply cut off by Slack?
- did the provider abort mid-stream?
- did a partial stream already reach the user?
- did a resumed turn use `chat.postMessage` instead of stream APIs?

## Practical Implementation Recommendation

If the goal is to solve this once and for all with the least ambiguity:

1. Treat provider-interrupted partial output as a bug and stop surfacing it silently.
2. Add hard overflow handling in Junior runtime code for every Slack reply path.
3. Patch the native stream stack so the first visible text can appear before newline completion and before 256 accumulated characters.
4. Add integration coverage that asserts actual `chat.startStream` / `chat.appendStream` cadence, not only final thread posts.

Without those four changes together, this area will continue to produce confusing and path-dependent Slack behavior.
