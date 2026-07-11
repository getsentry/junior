# Model Handoff Design

## Invariant

The current conversation projection owns model-visible Pi messages, the model
profile that must execute them, and the exact resolved model id recorded when
the projection opened. A projection is replaced atomically by a
`context_epoch_started` marker plus ordinary `pi_message` rows.

```ts
{
  type: "context_epoch_started";
  reason: "initial" | "compaction" | "handoff" | "rollback";
  modelProfile: "standard" | "advanced";
  modelId: string;
}
```

`modelProfile` is authoritative. Runtime resolves it through current host
configuration; `modelId` is audit-only and never pins execution. Legacy markers
may omit `modelId`, and legacy compaction/rollback markers may also omit
`modelProfile` and resolve to standard until the bounded import horizon ends.
Handoff always requires an explicit advanced binding.

## Control Flow

1. The standard model calls argument-free `handoff` as its only tool call.
2. Junior summarizes the committed current context.
3. One SQL transaction starts an advanced-bound projection containing exactly
   one synthetic user-role continuation summary.
4. The successful tool call sets a pending in-process transition.
5. Pi `prepareNextTurn` replaces the model, context, and tools before another
   provider request. The live runtime bootstrap is retained; raw prior history
   and the handoff call/result are not.
6. The advanced model completes the original request in the same run.

The projection commit is the success point. Before it, summary or persistence
failure leaves standard execution intact. After it, recovery loads the
advanced-bound projection and cannot downgrade.

Junior prepares the replacement runtime context, advanced model, toolset, and
usage bookkeeping before the commit. The commit is the final fallible tool
operation; successful return only activates that prepared state.

## Model Permanence

Every new conversation opens an explicit standard `initial` epoch with the
currently resolved standard model id. Legacy markerless histories still resolve
to standard without fabricating an old exact id. Handoff starts an advanced
projection. Capacity compaction and safe-boundary rollback copy the source
projection's profile and record its currently resolved model id, so permanence
requires no separate table, successor pointer, or all-history handoff scan.

## Runtime Continuity

Handoff preserves the conversation id, Pi run, workspace, exact sandbox id,
artifacts, configuration, actor attribution, credentials, source, destination,
auth, steering, delivery, timeout, and recovery behavior. Advanced receives
every normal main-agent tool except `handoff`.

Standard text is provisional until the assistant message proves it did not
request handoff. Text preceding a handoff call is discarded; ordinary standard
answers flush normally. Usage aggregates both model phases.

## Subagent Boundary

No advisor or delegate tool is exposed. Generic child-conversation storage and
`subagent_started`/`subagent_ended` history remain because a later subagent
design will build on those provider-neutral persistence primitives. Historical
advisor records remain decodable.
