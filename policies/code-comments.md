# Code Comments

## Intent

Comments are for non-obvious intent, module ownership, invariants, and
tradeoffs.

They are not there to narrate obvious code.

## Policy

- Major entry-point modules need a short design comment: ownership, boundary,
  and key invariants.
- Exported functions need a brief JSDoc comment explaining intent.
- Public TypeScript interfaces and their code comments are the canonical API documentation; do not maintain generated API reference docs.
- Private functions also need JSDoc when they define an internal interface:
  handlers/factories, wire or storage formats, signing, durable state changes,
  reply gates, or retry/resume/compaction/session policy.
- Comment non-obvious invariants, tradeoffs, and policy-driven behavior.
- Transitional compatibility branches and fallbacks require a removal TODO in
  the form `TODO(vX.Y.Z): Remove ...` where `vX.Y.Z` is the next release after
  the compatibility path is introduced. The comment must name the legacy state
  or behavior being tolerated, not just say "cleanup later".
- Keep comments short, concrete, and current.

## Exceptions

- Do not comment obvious transformations or control flow.
- Do not add comments that simply restate the code in English.
- Small obvious leaf helpers do not need comments.
- If there is no concrete release or condition for removing a compatibility
  path, prefer a hard cutover instead of adding the path.
