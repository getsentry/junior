# @sentry/junior-memory

The memory plugin stores durable, actor-scoped facts, recalls relevant facts
into prompts, and learns candidates from completed sessions. SQL schemas,
exported types, tools, and tests are authoritative.

## Surfaces

- `createMemory`, `removeMemory`, `listMemories`, and `searchMemories` are
  model-visible tools registered by `src/plugin.ts`.
- `userPrompt` recall contributes bounded memory context before a run.
- `processSession` reviews completed sessions asynchronously for passive
  learning.
- The `memory` CLI namespace provides explicit administrative search and
  inspection.

## Scope And Visibility

- Memory scope is derived from the active actor and source, never from
  model-supplied ownership fields.
- Private conversations and local sources remain private by default.
- Recall filters candidates by actor, source, visibility, status, and relevance
  before content reaches the model.
- Administrative reads require explicit selectors and safe output defaults.
- Memory content, embeddings, source excerpts, and review prompts must not be
  logged or traced.

## Storage

- The Drizzle schema in `src/db/schema.ts` and generated migrations define the
  database contract.
- Records retain provenance, lifecycle status, supersession relationships, and
  timestamps needed for review and deletion.
- Embeddings are derived indexes, not independent memory authority.
- Writes are idempotent where a completed session or tool retry can repeat.
- Removal and supersession preserve enough lifecycle information to prevent
  deleted facts from being recalled or silently recreated.

## Learning And Recall

- Explicit user requests to remember or forget take priority over passive
  learning.
- Passive extraction creates only durable, reusable facts—not transient tasks,
  conversation summaries, secrets, or speculative interpretation.
- Candidate review resolves duplicates and supersession before activation.
- Recall is bounded and relevance-ranked; an empty result contributes no filler
  prompt text.
- Model or embedding failures fail the owning hook/task without corrupting
  existing memory state.

## Configuration

- `AI_MEMORY_MODEL` or `createMemoryPlugin({ modelId })` selects the structured
  review model.
- `MEMORY_RECALL_MAX_VECTOR_DISTANCE` or
  `recallMaxVectorDistance` configures the vector candidate threshold.
- Generate schema changes with `pnpm --filter @sentry/junior-memory db:generate`.

Follow `../../policies/data-redaction.md`, `../../policies/security.md`, and the
plugin contract in `../junior-plugin-api/README.md`.
