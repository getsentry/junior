# Model Handoff Spec

## Metadata

- Created: 2026-07-11
- Last Edited: 2026-07-11

## Purpose

Define `handoff` as Junior's safe, permanent, in-place upgrade from the
standard model to the configured advanced model.

## Scope

- Main-agent model ownership and the `handoff` control-flow boundary.
- Handoff context replacement, durable profile selection, and recovery.

## Non-Goals

- Downgrading an advanced conversation or selecting arbitrary model ids.
- Creating a successor conversation, workspace, sandbox, or user-visible task.
- Changing thinking-level selection, tool authority, or delivery behavior.
- Designing a replacement advisor, delegate, or generic subagent runtime. Core
  child-conversation and subagent history storage remains available for that
  future work.

## Contracts

### Model Profiles

Junior exposes two conversation ownership profiles:

- `standard`: `AI_MODEL`
- `advanced`: `AI_ADVANCED_MODEL`, default `openai/gpt-5.6-sol`

Model-facing controls select profiles, never raw provider model ids. A main
conversation starts on standard and becomes permanently advanced after a
successful handoff. Thinking-level selection remains independent and is not
raised merely because the model changed.

### Tool Policy

Only a standard main agent receives the argument-free `handoff` tool. The
system prompt requires it for enumerated advanced work, including code changes,
debugging, architecture, broad refactors, research-heavy synthesis, and complex
planning. A durable conversation id is sufficient; handoff does not require a
resumable turn-session record. The tool description owns the permanent-upgrade
mechanics.

`handoff` must be the only tool call in its assistant message. Runtime blocks
every call in a mixed batch so no sibling side effect occurs. The tool is
sequential and cannot interrupt another in-flight tool call.

### In-Place Upgrade

Handoff does not create a conversation, successor, child, branch, sandbox, or
new user-visible session. It keeps the same:

- `conversationId` and Pi run
- workspace and exact sandbox id
- tools, except that advanced no longer receives `handoff`
- artifacts, configuration, actors, credentials, source, and destination
- timeout, steering, auth, delivery, persistence, and recovery behavior

After the handoff transaction commits, `prepareNextTurn` replaces the current
Pi model and context before the next provider request. Every normal main-agent
tool remains available.

### Context Replacement And Durability

Handoff reuses the context-compaction summarizer. The durable replacement
projection contains exactly one synthetic user-role handoff summary that tells
advanced to continue the outstanding request now, and no raw pre-handoff user,
assistant, reasoning, tool-call, or tool-result messages.

The same transaction opens a `context_epoch_started` marker with:

```ts
{
  type: "context_epoch_started";
  reason: "handoff";
  modelProfile: "advanced";
  modelId: "<resolved AI_ADVANCED_MODEL>";
}
```

The in-process advanced continuation also receives the current volatile
runtime bootstrap as a sibling message so actionable skill catalogs,
configuration, and workspace facts remain available. Existing transcript
stripping rules keep that bootstrap out of completed durable semantic history.

The current projection marker's `modelProfile` is the runtime authority. Its
`modelId` is an audit snapshot of the exact configured model when that epoch was
opened; it never pins runtime selection. Every new conversation opens an
explicit `initial` epoch with the standard profile and its resolved model id.
Handoff starts an advanced-bound projection, and every later compaction or
rollback copies that profile while recording its newly resolved model id, so
configuration drift remains visible without creating a downgrade path or an
all-history scan. Legacy markerless history still resolves to standard with no
invented historical model id.

## Failure Model

Summary generation and epoch persistence happen before handoff succeeds. If
either fails, the tool produces a normal Pi error result, no replacement epoch
becomes active, and the standard model continues normally.
The tool forwards the active turn's abort signal to summarization and checks it
again immediately before persistence. Cancellation observed at that boundary
prevents the advanced epoch; once the epoch transaction starts, its result is
authoritative.

Junior prepares the replacement runtime context, advanced model, toolset, and
usage bookkeeping before opening the epoch. The epoch commit is the final
fallible operation in the tool; after it resolves, the runtime only activates
that prepared state.

After the epoch commits, the upgrade is authoritative. A resumable turn
reconstructs the committed advanced context after process death. A recordless
turn remains permanently advanced on its next invocation but cannot
automatically resume the interrupted request. A later provider or tool error is
an advanced-run failure, not a handoff failure.

## Observability

Handoff uses the existing `gen_ai.invoke_agent` request spans. Model phases are
identified by `gen_ai.request.model`; the durable transition records
`app.ai.model_profile = "advanced"`.
Final turn diagnostics identify the model that completed the turn. No bespoke
handoff event or span is added.

## Verification

- Component: successful handoff writes a summary-only epoch and resolves the
  conversation to advanced.
- Component: summary failure leaves the prior projection and standard profile
  unchanged.
- Integration: one turn starts standard, invokes standalone handoff, preserves
  runtime bootstrap/tools, and completes on advanced.
- Integration: a later turn in the same conversation starts directly on the
  distinct advanced model without another handoff.
- Eval: an enumerated architecture task selects `handoff` and produces the
  requested advanced response.
- Eval: a distinct-model two-turn coding task performs one handoff, reuses the
  same workspace file, posts both replies, and records only advanced assistant
  steps after the follow-up boundary.
- Manual: `pnpm cli -- chat ...` shows the handoff tool and same-turn answer.

## Related Specs

- `./context-compaction.md`
- `./agent-session-resumability.md`
- `./harness-agent.md`
- `./agent-prompt.md`
- `./terminology.md`
