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
- The dashboard exposes a searchable, paginated **Memories** user page for
  personal memories owned by actors linked to the signed-in viewer. Its
  **Forget** action archives the selected memory.
- Authenticated REST clients can list and search personal memories through
  `GET /api/plugins/memory/memories`, read one through
  `GET /api/plugins/memory/memories/:id`, and archive one through
  `DELETE /api/plugins/memory/memories/:id`. Personal bearer tokens remain
  read-only, so mutations require a dashboard browser session.

## Scope And Visibility

- Memory scope is derived from the active actor and source, never from
  model-supplied ownership fields.
- Dashboard and REST requests authorize one verified viewer, then resolve every
  linked platform actor internally so one arbitrary actor is never treated as
  the viewer's canonical identity.
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
- Embedding distance never decides that two memories are duplicates. Exact
  content and preference review own duplicate and supersession decisions.
- Writes are idempotent where a completed session or tool retry can repeat.
- Removal and supersession preserve enough lifecycle information to prevent
  deleted facts from being recalled or silently recreated.

## Learning And Recall

- Explicit user requests to remember or forget take priority over passive
  learning.
- Passive extraction creates only durable, reusable facts—not transient tasks,
  conversation summaries, secrets, or speculative interpretation.
- Every completed passive extraction emits the namespaced
  `memory/memories_captured` conversation event with its best-effort model cost.
  Empty extraction outcomes remain durable for reporting but do not produce a
  transcript row.
- Candidate review resolves duplicates and supersession before activation.
- Search combines independently ranked vector and PostgreSQL full-text matches
  with reciprocal rank fusion; provider-specific raw scores are never added
  together.
- Automatic recall retrieves a broad candidate window, then uses the
  memory-owned relevance model to admit at most five directly useful memories.
  An empty result contributes no filler prompt text.
- Automatic recall degrades to no prompt contribution when relevance selection
  fails. Review, extraction, and write failures still fail their owning
  hook/task without corrupting existing memory state.

## Configuration

- `AI_MEMORY_MODEL` or `memoryPlugin({ modelId })` selects the structured
  review model.
- `MEMORY_RECALL_MAX_VECTOR_DISTANCE` or
  `recallMaxVectorDistance` configures the vector candidate threshold.
- Generate schema changes with `pnpm --filter @sentry/junior-memory db:generate`.

Follow `../../policies/data-redaction.md`, `../../policies/security.md`, and the
plugin contract in `../junior-plugin-api/README.md`.
