# Code Comments

## Intent

A comment says what a reader cannot get from the code or from the doc that
owns the fact. Each comment line costs reader attention and can go stale, so
a comment must earn its place.

## Policy

- Comment only these: why the code does something, an invariant, a
  non-obvious rule or tradeoff, an order or concurrency constraint, or an
  intentional absence that affects correctness, security, privacy, delivery,
  or recovery.
- Exported functions get a brief JSDoc that states intent, usually one or two
  sentences. Do not restate the signature, the types, or the body.
- A major entry-point module gets a short header: what it owns and its key
  invariants.
- A private function that defines an internal interface, such as a wire or
  storage format or a durable state change, gets a brief JSDoc.
- Public TypeScript interfaces and their comments are the canonical API
  documentation. Do not maintain generated API reference docs.
- Do not repeat a fact that another source owns. Link the source or leave the
  fact out:
  - Goals and rules that users rely on: `design/`.
  - Behavior claims: the verify-junior map. Tests prove behavior.
  - Span, metric, and attribute names: `TELEMETRY.md`.
  - What another module does: the comment in that module.
- Do not write Given/When/Then scenario lists, test file paths, change
  history, or catalogs of attributes, reasons, or error codes in a comment.
- A comment block has at most 12 lines (`comment-length:check`). A longer
  block usually belongs in `design/`, a policy, or a type. Do not split it
  into smaller comments to pass.
- Every TODO must name an owner in the form `TODO(owner): ...`.
- A removal TODO must name what will be removed and the condition that makes
  removal safe. Use a version only when support for that version is the real
  condition. Do not invent a release deadline.

## Exceptions

- Small obvious helpers need no comment. Do not restate code in English.
- If there is no concrete condition for removing a compatibility path, prefer
  a hard cutover instead of adding the path.
