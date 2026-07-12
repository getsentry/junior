# Model Handoff Spec

## Metadata

- Created: 2026-07-11
- Last Edited: 2026-07-12

## Purpose

Define `handoff` as Junior's safe, permanent, in-place switch from the standard
model to a host-configured named model profile.

## Scope

- Main-agent model ownership and the `handoff` control-flow boundary.
- Handoff context replacement, durable profile selection, and recovery.

## Non-Goals

- Downgrading or handing off an already handed-off conversation again.
- Letting a model select arbitrary provider model ids.
- Creating a successor conversation, workspace, sandbox, or user-visible task.
- Changing thinking-level selection, tool authority, or delivery behavior.
- Designing an advisor, delegate, or generic subagent runtime. Generic
  child-conversation and subagent history storage remains for future work.

## Contracts

### Model Profiles

Model profiles are stable, host-owned names matching
`^[a-z][a-z0-9_-]*$`. Junior provides two reserved profiles:

- `standard`: resolves through `AI_MODEL` and owns every new conversation.
- `handoff`: resolves through `AI_HANDOFF_MODEL`, which defaults to
  `openai/gpt-5.6-sol`, and is the default handoff target.

`AI_MODEL_PROFILES` may add other non-standard profiles as a JSON object from
profile name to provider model id. It cannot override `standard` or `handoff`.
Model-facing controls select only configured profile names, never raw model
ids. Thinking-level selection remains independent of profile selection.

### Tool Policy

Only a standard main agent receives `handoff`. Its optional `profile` argument
is constrained to configured non-standard profiles; omitting it or passing
`null` selects `handoff`. The system prompt requires handoff for enumerated higher-capability
work such as code changes, debugging, architecture, broad refactors,
research-heavy synthesis, and complex planning, and tells the model to choose
the profile whose name best fits the task.

A durable conversation id is sufficient; handoff does not require a resumable
turn-session record. `handoff` must be the only tool call in its assistant
message. Runtime blocks every call in a mixed batch so no sibling side effect
occurs. The tool is sequential and cannot interrupt another in-flight call.

### In-Place Switch

Handoff does not create a conversation, successor, child, branch, sandbox, or
new user-visible session. It keeps the same:

- `conversationId` and Pi run
- workspace and exact sandbox id
- normal main-agent tools, except that `handoff` is removed
- artifacts, configuration, actors, credentials, source, and destination
- timeout, steering, auth, delivery, persistence, and recovery behavior

After the handoff transaction commits, `prepareNextTurn` replaces the current
Pi model and context before the next provider request.

### Context Replacement And Durability

Handoff reuses the context-compaction summarizer. The durable replacement
projection contains exactly one synthetic user-role continuation summary and
no raw pre-handoff user, assistant, reasoning, tool-call, or tool-result
messages.

The same transaction opens a `context_epoch_started` marker with:

```ts
{
  type: "context_epoch_started";
  reason: "handoff";
  modelProfile: "<selected configured profile>";
  modelId: "<resolved model id at epoch creation>";
}
```

The in-process continuation also receives the current runtime bootstrap as a
sibling message. The handoff transaction itself persists only the summary;
ordinary checkpoints may later append that bootstrap and post-handoff output
to the same profile-bound epoch. This matches normal completed-turn prompt
storage: same-projection follow-ups reuse the current bootstrap, while later
context replacement strips it before injecting a fresh bootstrap.

The current marker's `modelProfile` is runtime authority. Its `modelId` is an
audit snapshot and never pins runtime selection. Every new conversation opens
an explicit `initial` epoch bound to `standard`. Later compaction or rollback
copies the current profile and records its newly resolved model id. If a
durably selected custom profile is no longer configured, runtime fails rather
than falling back to the stored audit id or another profile. Legacy markerless
history still resolves to `standard` without inventing a historical model id.

## Failure Model

The target profile and model are resolved before summarization. Summary
generation and epoch persistence happen before handoff succeeds. If either
fails, no replacement epoch becomes active and Pi receives a normal tool error.
The active abort signal is checked again immediately before persistence.

Before summary generation begins, runtime reports `Switching models` through
the normal assistant progress surface. This is deterministic runtime progress,
not a model-authored `reportProgress` tool call.

Junior prepares the replacement runtime context, target model, toolset, and
usage bookkeeping before opening the epoch. The epoch commit is the final
fallible tool operation. After it resolves, the selected profile is
authoritative. Resumable recovery reconstructs that committed context; a
recordless later invocation starts on the selected profile but cannot resume
the interrupted request automatically.

## Observability

Handoff uses existing `gen_ai.invoke_agent` request spans. Model phases are
identified by `gen_ai.request.model`, and `app.ai.model_profile` records the
active profile name. Final diagnostics identify the model that completed the
turn. No bespoke handoff event or span is added.

## Verification

- Component: configuration validates reserved and custom named profiles.
- Component: successful handoff writes a summary-only profile-bound epoch at
  the handoff transaction boundary;
  failure leaves the standard projection unchanged.
- Integration: default and explicitly selected profiles swap model/context in
  the same turn, remove only `handoff`, and own later turns permanently.
- Integration: mixed batches, yield, and worker recovery preserve the boundary.
- Eval: a distinct-model two-turn coding task performs one handoff, reuses the
  same workspace file, and executes the follow-up on the handed-off model.
- Manual: `pnpm cli -- chat ...` shows handoff and a same-turn answer.

## Related Specs

- `./context-compaction.md`
- `./agent-session-resumability.md`
- `./harness-agent.md`
- `./agent-prompt.md`
- `./terminology.md`
