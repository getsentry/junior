# @sentry/junior-memory

The memory plugin stores durable facts, recalls relevant facts
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
- The dashboard exposes a searchable, paginated **Memories** user page. It
  includes public memory and private memory owned by the authenticated user.
  The overview charts global passive-extraction cost from the durable
  `memory/memories_captured` events. The System plugin report uses the same
  event-cost feed.
- Authenticated REST clients can list and search authorized memories through
  `GET /api/plugins/memory/memories`, read one through
  `GET /api/plugins/memory/memories/:id`, and forget an authorized private
  memory through `DELETE /api/plugins/memory/memories/:id`. Public memory is
  read-only on these viewer surfaces.

## Scope And Visibility

- Memory visibility is derived from the Source, never from model-supplied
  ownership fields.
- Public memory is visible everywhere.
- Private memory is owned by one canonical User. It is visible through every
  Identity linked to that User.
- Junior records the optional Location where it learned a memory. Location is
  provenance only. It does not grant access.
- Subject classification is independent from visibility. A user preference can
  be public or private based on its Source.
- Recall filters candidates by visibility, status, and relevance before content
  reaches the model.
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
- Both retrieval legs always run in parallel as bounded top-k probes. Each leg
  fetches at least the caller's requested limit (and never more than the store
  limit ceiling). Recall keeps a smaller overfetch window than explicit search
  and slightly prefers lexical ranks so exact tokens survive soft semantic
  neighbors. Vector recall also applies the cosine distance cutoff in SQL, and
  embeddings use an HNSW cosine index (`vector_cosine_ops`).
- Automatic recall also runs private-scope-only vector and lexical probes so
  older private memory is not buried when newer public memory fills the shared
  lexical recency window with common tokens. On RRF score ties, private matches
  rank ahead of public matches.
- Automatic recall retrieves a bounded candidate window, then uses the
  memory-owned relevance model and prompt budget to admit directly useful
  memories. An empty result contributes no filler prompt text.
- Every completed automatic recall attempt emits an invisible, namespaced
  `memory/memories_recalled` conversation event with the admitted memory IDs
  and best-effort embedding and relevance-model cost, including retrievals that
  find no candidates and decisions that admit no memories.
- Automatic recall degrades to no prompt contribution when relevance selection
  fails. Review, extraction, and write failures still fail their owning
  hook/task without corrupting existing memory state.

## Configuration

- `AI_MEMORY_MODEL` or `memoryPlugin({ modelId })` selects the structured
  review model.
- `memoryPlugin({ disableRecall: true })` disables automatic prompt recall.
- `memoryPlugin({ disableExtraction: true })` disables passive session
  extraction. The two flags are independent and do not disable explicit memory
  tools.
- Automatic recall uses a fixed cosine distance cutoff of `0.45` (for
  `text-embedding-3-small`). Explicit search does not apply that cutoff.
- Generate schema changes with `pnpm --filter @sentry/junior-memory db:generate`.

Follow `../../policies/data-redaction.md`, `../../policies/security.md`, and the
plugin contract in `../junior-plugin-api/README.md`.
