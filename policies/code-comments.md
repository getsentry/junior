# Code Comments

## Intent

Comments are for non-obvious intent, module ownership, invariants, and
tradeoffs.

They are not there to narrate obvious code.

## Policy

- Major entry-point modules must start with a short design comment. This
  includes modules that own Slack/runtime ingress, agent execution, prompt
  assembly, durable state, compaction, auth/resume flows, queues, workers, or
  cross-system orchestration.
- A module design comment should explain what the module owns, the boundary it
  protects, and one or two invariants future changes must preserve.
- Add comments when behavior is easy to misread, policy-driven, or coupled to a non-obvious invariant.
- Exported functions must have a brief JSDoc comment explaining intent so future readers can change them safely.
- Significant interface functions must have a brief JSDoc comment whether they are exported or private. A function is significant when it defines a module boundary, returns a handler/factory, parses or emits a wire/storage format, signs or verifies data, changes durable state, chooses session/projection boundaries, gates reply behavior, or encodes retry/resume/compaction policy.
- Small local helpers can stay uncommented when their name and implementation are obvious and they do not encode a boundary or policy decision.
- Keep comments short and concrete. Explain why the code exists or what boundary it is protecting.
- Update the design comment when a module's ownership, lifecycle, or invariants
  change.
- Delete or rewrite stale comments immediately when behavior changes.

## Exceptions

- Do not comment obvious transformations or control flow.
- Do not add comments that simply restate the code in English.
- Small leaf modules that expose a single obvious helper do not need a module
  design comment.
