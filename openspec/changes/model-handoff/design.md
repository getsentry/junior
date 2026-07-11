# Model Handoff Design

## Invariant

The current conversation projection owns model-visible Pi messages, the
host-owned model profile that must execute them, and the exact resolved model id
recorded when the projection opened:

```ts
{
  type: "context_epoch_started";
  reason: "initial" | "compaction" | "handoff" | "rollback";
  modelProfile: string;
  modelId: string;
}
```

`modelProfile` is authoritative. Runtime resolves it through current host
configuration; `modelId` is audit-only. `standard` and `handoff` are reserved.
The latter defaults to `openai/gpt-5.6-sol`; hosts may add named non-standard
profiles. Deployed compaction/rollback markers without model bindings remain
readable as standard history.

## Control Flow

1. The standard model calls `handoff` alone, optionally selecting a configured
   profile; omission or `null` selects `handoff`.
2. Junior resolves the selected profile and prepares its target model.
3. Junior summarizes the committed current context.
4. One SQL transaction starts a profile-bound projection containing one
   synthetic user-role continuation summary.
5. Pi `prepareNextTurn` replaces model, context, and tools before another
   provider request. The runtime bootstrap is retained; raw prior history and
   the handoff call/result are not.
6. The selected model completes the original request in the same run.

The projection commit is the success point. Before it, failure leaves standard
execution intact. After it, recovery loads the selected profile and cannot
downgrade or hand off again.

## Profile Catalog

`AI_MODEL` resolves `standard`. `AI_HANDOFF_MODEL` resolves `handoff` and
defaults to `openai/gpt-5.6-sol`. `AI_MODEL_PROFILES` is a JSON object from
additional stable profile names to provider model ids. Only configured
non-standard names appear in the tool schema; raw ids never do. Removing a
custom profile still referenced by durable history is an explicit runtime
configuration error, not a fallback to the stored audit id.

## Runtime Continuity

Handoff preserves conversation id, Pi run, workspace, exact sandbox id,
artifacts, configuration, actors, credentials, source, destination, auth,
steering, delivery, timeout, and recovery behavior. The selected profile
receives every normal main-agent tool except `handoff`. Standard text remains
provisional until the assistant message proves it did not request handoff.
Usage aggregates both model phases.

## Subagent Boundary

No advisor or delegate tool is exposed. Generic child-conversation storage and
`subagent_started`/`subagent_ended` history remain for a later subagent design.
Historical advisor records remain decodable.
