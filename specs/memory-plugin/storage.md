# Memory Plugin Storage

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define the memory plugin's broad SQL storage design, embedding storage
mechanism, model-provider boundary, and operational rules without prescribing
exact migrations or DDL.

## Contracts

### Storage Ownership

The memory plugin owns its SQL schema, Drizzle table definitions, and packaged
migrations under [`../plugin-database.md`](../plugin-database.md).

This spec defines the shape and invariants those migrations must satisfy. It
does not define exact migration filenames, full column lists, or generated SQL.

### Data Classes

The plugin stores two classes of data:

1. **Memory records**: the durable source of truth for facts that may be
   recalled later.
2. **Retrieval indexes**: derived data, such as embeddings and lexical indexes,
   that can be deleted and rebuilt from memory records.

The implementation may use one table per class or split them further if needed.
The first authoritative storage slice keeps the shape simple:

- one authoritative memory-record table
- no canonical graph/entity/fact tables

The embedding slice adds one derived embedding/vector table or equivalent vector
index. Optional database-native lexical search support may be added with the
retrieval slice.

### Memory Record Shape

Each memory record must contain enough information to enforce visibility and
lifecycle without consulting the original transcript.

Required conceptual fields:

- stable memory id
- self-contained memory content
- memory type
- runtime-derived visibility scope
- subject type
- runtime-derived subject key when the subject is a user or conversation
- runtime-derived source attribution
- observation or tool idempotency marker
- observed timestamp
- created timestamp
- optional expiration timestamp
- optional supersession link
- archive timestamp and reason

The first storage slice intentionally keeps this authoritative row lean.
Subject/display labels, extraction confidence, and operational metadata should
be added only with the extraction, graph, or admin consumer that needs them.

Scope and source fields are authority-bearing. Subject fields describe the
memory's topic, but they must not grant visibility beyond scope. The stored
subject key is runtime-derived internal metadata, not model-visible tool input
or ordinary memory output. Display labels, model-generated summaries, and tool
arguments are not authorities.

V1 stores only public/shareable memory content, so the authoritative row must
not include a dormant sensitivity or classification column. If a future feature
supports non-public memory, it must add a new end-to-end contract; existing V1
rows can be backfilled or interpreted as public/shareable without semantic
recategorization.

### Derived Graph Data

Graph/entity/fact storage is out of scope for V1. Prior-art systems that use a
graph still treat episodes, passages, or memory items as the source from which
graph edges are derived.

If Junior later needs entity linking, relationship retrieval, or multi-hop
recall, it should add separate derived graph tables keyed by memory id and
source attribution. Those tables must be rebuildable from authoritative memory
records plus bounded source references. Graph nodes, aliases, display labels,
and model-extracted entity subjects must not become authorization principals.

### Visibility Data

The storage model must support these V1 visibility scopes:

- personal memory owned by the current requester identity
- conversation memory owned by the current source/destination conversation

The stored scope must be derived from runtime context before write. Model-visible
tool input cannot provide requester ids, actor ids, workspace ids, channel ids,
thread ids, or arbitrary conversation ids.

The store must be able to filter active visible records by:

- scope
- plugin-derived subject type
- current install policy
- archive state
- supersession state
- expiration

### Idempotency And Duplicates

Passive extraction must be idempotent across repeated observations, queue
redelivery, and task retry. The store needs a stable source marker for a
completed observation and the extracted fact's position or stable fact id inside
that observation.

Semantic duplicate suppression needs extractor and retrieval context. It should
run before insertion when implemented, but V1 storage does not use exact-content
hashing as memory identity.

### Lexical Search

Lexical search is required because embeddings are optional operationally and can
fail independently of memory writes.

The storage layer should use Postgres-native text search or an equivalent SQL
indexable mechanism. Retrieval must still apply the memory visibility predicate
before returning rows to prompt rendering or tools.

### Embedding Storage

Embeddings are derived retrieval data. They are not the authority for memory
existence, visibility, or deletion.

When the embedding slice is implemented, embedding rows or index entries must
record:

- memory id
- provider id
- model id
- dimensions
- distance metric
- content hash that was embedded
- vector value
- created/repaired timestamps

The plugin should not store raw embedding-provider request or response payloads.

Changing provider, model, dimensions, or metric requires re-embedding active
memories. Missing or stale embeddings degrade retrieval to lexical and recency
ranking.

Vectors inherit the scope, retention, deletion, and provider policy of their
source memory. Archiving or deleting a memory must remove or invalidate derived
vectors under the same rules as the memory content.

### Vector Storage

V1 should use Postgres-native vector storage through pgvector when embeddings
are enabled. The default should be a fixed-dimensional vector column compatible
with the configured embedding model.

Use cosine distance by default. `text-embedding-3-small` at 1536 dimensions is
the expected default because it fits a common pgvector setup and matches the Ash
prototype's default. Larger native embedding models must either be configured to
return the stored dimension or wait for a migration/rebuild plan that changes
the stored vector dimension.

### Vector Index Strategy

The retrieval design should not assume approximate vector indexes are necessary
on day one.

V1 should start with exact vector ranking over visible active candidates. If
production data shows that exact ranking is too slow, add an approximate
pgvector index such as HNSW and overfetch results before applying exact
visibility filtering and final reranking.

Approximate vector search is a performance tool, not an authorization boundary.

### Embedding Provider

Core must keep provider credentials and expose only a narrow host capability to
trusted plugin hooks and tasks:

```ts
interface PluginEmbeddingProvider {
  embed(input: {
    texts: string[];
    purpose: "memory";
    model?: string;
    dimensions?: number;
  }): Promise<{
    provider: string;
    model: string;
    dimensions: number;
    vectors: number[][];
  }>;
}
```

Rules:

1. The provider is host runtime code, not a model-visible tool.
2. The memory plugin never receives provider API keys.
3. The returned vector count must equal the input text count.
4. Empty or whitespace-only texts are rejected before provider calls.
5. The returned dimensions must match the configured vector storage.
6. Provider failures do not roll back accepted memory content.
7. Missing embeddings degrade recall to lexical and recency ranking.

The default embedding configuration should be:

```txt
provider = openai-compatible
model = text-embedding-3-small
dimensions = 1536
metric = cosine
```

The exact provider name is deployment configuration. Stored embedding metadata
records the resolved provider and model used for each vector.

### Write Path

Memory creation follows this order:

1. Validate content, scope, source, expiration, and metadata.
2. Run model-assisted policy adjudication when needed.
3. Run deterministic public-content policy validation and centralized secret
   rejection.
4. Insert the memory record transactionally.
5. After the transaction commits, batch-generate embeddings for inserted records
   when an embedding provider is configured.
6. Store or repair vector data only when provider output matches the configured
   vector storage.

Provider calls must not run inside the SQL transaction.

If embedding generation fails, the memory remains active and can be found
through lexical/list retrieval. A later embedding repair task may repair missing
or stale embeddings.

If install policy disables embeddings or a provider for a scope, the write path
must skip vector generation without failing the memory write.

### Repair And Rebuild

Embedding repair should run through plugin background work rather than request
handlers.

The repair task finds active memories where:

- no vector exists
- the vector was generated from an old content hash
- provider/model/dimensions differ from current config

It processes bounded batches and is idempotent.

### Removal And Lifecycle

Memory removal archives in place:

- set archive timestamp and reason
- exclude from recall and normal list results
- delete or ignore derived embedding/vector data

Physical deletion is reserved for future retention, export, and account
deletion workflows.

Memory maintenance must archive:

- memories whose expiration is in the past
- ephemeral memories older than their type default TTL
- superseded memories after the supersession marker is committed

V1 may perform this maintenance opportunistically during create, list, recall,
remove, extraction, and embedding repair paths. A future low-frequency
maintenance task may be specified separately if opportunistic cleanup is
insufficient.

## Related Specs

- `./index.md`
- `./policy.md`
- `./security.md`
- `./retrieval.md`
- `./extraction.md`
- `../plugin-database.md`
- `../credential-injection.md`
