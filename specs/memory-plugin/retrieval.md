# Memory Plugin Retrieval

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define how the memory plugin recalls active visible memories, optionally
injects them into model-visible user prompts, and exposes explicit recall
through `searchMemories`.

## Automatic Injection Policy

Install policy controls whether recall is automatic or tool-mediated:

- `autoInjectMemories: true` enables `userPrompt` memory injection.
- `autoInjectMemories: false` disables memory injection; the model-visible recall
  path is `searchMemories`.

This setting does not control writes. Passive extraction and explicit creation
are governed by the extraction and tool policies in [`./policy.md`](./policy.md).

## Automatic Recall

The memory plugin recalls memories through `userPrompt(ctx)`.

Core invokes the hook once while constructing each fresh triggering user prompt.
Resume records that already contain a prompt checkpoint continue from stored Pi
history and do not invoke `userPrompt` again. When automatic memory injection is
disabled by policy, the plugin must return no memory contribution.

When automatic memory injection is enabled, the plugin must:

1. Derive visible memory scopes from `ctx.requester`, `ctx.source`,
   `ctx.destination`, and `ctx.conversationId`.
2. Query active visible memories relevant to `ctx.text`.
3. Return one concise prompt contribution containing only accepted memory
   content.

## Tool-Mediated Recall

When automatic memory injection is disabled, `searchMemories` is the only
model-visible recall path. It must use the same visibility filter, policy
checks, ranking pipeline, and result budgets as automatic memory injection.

`searchMemories` may return ids or short ids when useful for follow-up memory
management, but it should otherwise return concise memory content and avoid
private metadata. The tool must derive all authority-bearing scopes from
runtime context, not from model-supplied arguments.

`searchMemories` should not suppress results merely because they may have been
included by automatic injection in an earlier run.

### Visibility Filter

Retrieval must filter by visibility before prompt rendering:

- matching personal requester scope
- matching conversation scope
- current install policy allows recall for the memory type, scope, and source
- `archived_at is null`
- `superseded_at is null`
- `expires_at is null or expires_at > now()`

The query planner, vector index, model, and ranker are not authorization
boundaries.

If install policy changes after a memory was created, retrieval must apply the
current policy. Stricter current policy hides the memory from automatic memory
injection and normal list/search results even if the stored row is otherwise
visible.

### Ranking Pipeline

The first storage slice uses lexical retrieval without a graph or vector index:

1. Build visible active candidate scopes.
2. Run lexical search against memory content.
3. Apply small deterministic boosts for exact scope match, durable memory
   types, subject match, and recent observations.
4. For automatic injection only, drop memories already injected into the active
   session projection.
5. Return the top memories within count and character budgets.

The later embedding slice may upgrade this to hybrid retrieval:

1. Run vector search when embeddings are configured and the user text can be
   embedded.
2. Merge lexical and vector results with reciprocal-rank style fusion.
3. Apply the same visibility filtering, deterministic boosts, and prompt
   budgets.

Vector results should be overfetched before final filtering and prompt
formatting. Approximate vector search must be exact-reranked over visible
candidates before injection.

### Exact Versus Indexed Vector Search

The store should choose the simplest safe query for the visible candidate set:

- If visible candidate count is small, rank exact cosine distance inside SQL.
- If visible candidate count is large and an HNSW index exists, use approximate
  vector search with an overfetch multiplier, then re-rank exact visible
  candidates.
- If embedding generation fails, skip vector search and continue with lexical,
  recency, and type ranking.

This keeps correctness independent of pgvector index tuning.

### Prompt Rendering

The memory prompt contribution should be short, stable, and clearly separated
from the user's request.

Core owns the wrapper. The plugin owns the contribution text. The contribution
must:

- include only active visible memories
- stay within configured count and character limits
- avoid raw provenance unless needed for disambiguation
- avoid ids
- not include secrets or archived facts
- not include facts whose scope is no longer visible

Memory content is context, not instruction. The rendered contribution should
make clear that memories may be stale and should not override direct user
corrections or current repository evidence.

## Related Specs

- `./index.md`
- `./policy.md`
- `./storage.md`
- `./security.md`
- `../plugin-prompt-hooks.md`
- `../agent-prompt.md`
