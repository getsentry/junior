# Code Comments

## Intent

Comments record non-obvious intent, module ownership, rules, and tradeoffs.
They do not narrate obvious code.

## Policy

- Major entry-point modules need a short design comment: ownership, edge, and
  key rules.
- Exported functions need a brief JSDoc comment that explains intent.
- Public TypeScript interfaces and their code comments are the canonical API
  documentation. Do not maintain generated API reference docs.
- Private functions also need JSDoc when they define an internal interface:
  handlers or factories, wire or storage formats, signing, durable state
  changes, reply gates, or retry, resume, compaction, or session policy.
- Comment non-obvious rules, tradeoffs, and policy-driven behavior.
- When an owning edge intentionally omits behavior a maintainer would
  reasonably expect, document that absence when it affects correctness,
  security, privacy, delivery, or recovery.
- Every TODO must name an owner in the form `TODO(owner): ...`.
- A removal TODO must name what will be removed and the condition that makes
  removal safe. Use a version only when support for that version is the real
  condition. Do not invent a release deadline.
- Keep comments short, concrete, and current.

## Exceptions

- Small obvious leaf helpers need no comment. Do not restate code in English.
- If there is no concrete condition for removing a compatibility path, prefer
  a hard cutover instead of adding the path.
