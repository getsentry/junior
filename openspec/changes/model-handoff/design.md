# Model Handoff Design

## Invariant

The current conversation projection owns both model-visible Pi messages and the
model profile that must execute them. A projection is replaced atomically by a
`context_epoch_started` marker plus ordinary `pi_message` rows.

```ts
{
  type: "context_epoch_started";
  reason: "compaction" | "handoff" | "rollback";
  modelProfile: "standard" | "advanced";
}
```

Legacy compaction and rollback markers may omit `modelProfile` and resolve to
standard until the bounded import horizon ends. Handoff always requires an
explicit advanced binding.

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

Initial epoch-zero conversations resolve to standard. Handoff starts an
advanced projection. Capacity compaction and safe-boundary rollback copy the
source projection's model binding, so permanence requires no separate table,
successor pointer, or all-history handoff scan.

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
