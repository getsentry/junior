# Memory plugin

## Intent

- The plugin stores durable facts, recalls relevant facts into prompts, and
  learns candidates from completed sessions.
- SQL schemas, exported types, tools, and tests are authoritative.

## Visibility

- The Source sets visibility. Model output never sets it.
- Public memory is visible everywhere. Private memory belongs to one User and
  every Identity linked to that User.
- Location and subject are records. They do not grant access.
- Filter by visibility and status before content reaches the model.
- Only the main agent writes memory. Child agent runs get read tools only.
- Public memory is read-only in the dashboard and REST API.

## Privacy

- Never log or trace memory content, embeddings, source excerpts, or review
  prompts. Follow `policies/data-redaction.md`.
- Administrative reads need explicit selectors and safe output defaults.

## Storage

- `src/db/schema.ts` and generated migrations own the database contract.
- Embeddings are derived indexes, not memory authority.
- Embedding distance only selects candidates. Exact content and model review
  decide duplicates. Only user preferences can supersede old memories.
- Writes are idempotent where a session or tool retry can repeat.
- Removal and supersession keep enough lifecycle data so that deleted facts
  are not recalled or recreated.

## Learning and recall

- Explicit remember and forget requests win over passive learning.
- Passive extraction keeps only durable, reusable facts. Never store tasks,
  summaries, secrets, or guesses.
- Search fuses vector and full-text ranks with reciprocal rank fusion. Never
  add provider raw scores together.
- Recall also searches private memory on its own, so newer public memory does
  not hide it.
- When relevance selection fails, recall adds no prompt text. Review,
  extraction, and write failures fail their owning hook or task and must not
  corrupt stored memory.
- Event `costUsd` is extra operation cost. Do not repeat cost that the agent
  model usage already records.
