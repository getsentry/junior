# Memory Plugin Spec

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define Junior's first long-term memory implementation as an explicitly enabled
runtime hook plugin with strict storage, recall, visibility, and deletion
contracts.

## Implementation Status

This spec describes the intended V1 memory plugin shape. Generic plugin prompt
hooks and plugin prompt session state are available through
`../plugin-prompt-hooks.md`. Passive learning still depends on future
`observeTurn` and plugin background task handler surfaces.

V1 stores only public/shareable memory content. Scope controls who can see a
record; it is not a content sensitivity model. Private, sensitive, secret, or
otherwise restricted content is rejected instead of being stored with a
classification label.

When automatic memory injection is enabled, the memory plugin makes relevant
facts available before each response without making recall depend on the model
choosing a search tool. When automatic memory injection is disabled,
model-visible recall is explicit through `searchMemories`. Other explicit tools
support user-directed memory management.

## Scope

- What is eligible for long-term memory.
- Install-level policy controls for workplace-safe extraction and recall.
- Memory plugin package shape and required plugin hooks.
- Plugin-owned SQL storage, retrieval indexes, embeddings, and model-provider
  boundaries.
- Automatic recall through `userPrompt` when `autoInjectMemories` is enabled.
- Passive learning through `observeTurn` plus a plugin background task handler.
- Explicit `createMemory`, `removeMemory`, `listMemories`, and
  `searchMemories` tools.
- Scope, attribution, lifecycle, tool, model, public-content, and secret
  rejection rules.
- V1 implementation order and verification requirements.

## Non-Goals

- A core memory API outside the plugin system.
- A canonical person graph, alias resolver, or multi-hop social retrieval.
- Storing private, sensitive, secret, or otherwise restricted memory content in
  V1.
- Cross-context recall between unrelated conversations.
- Requiring search tools when automatic memory injection is enabled.
- Storing conversation transcript history as memory.
- Storing credentials, secrets, raw OAuth data, or provider tokens.
- Letting model-supplied tool arguments choose actors, Slack workspaces,
  channels, teams, or arbitrary visibility scopes.
- Exposing memory content through logs, traces, dashboard metadata, or plugin
  operational reports for private conversations.

## Spec Map

Read these files as one canonical spec:

- [storage.md](./storage.md): SQL storage model, retrieval indexes, pgvector,
  embedding model provider, and operational storage rules.
- [policy.md](./policy.md): install-level controls for memory categories,
  passive extraction, workplace-sensitive facts, model/provider use, and
  retention.
- [security.md](./security.md): authority boundaries, multi-user visibility,
  model/tool boundaries, task payload safety, and redaction rules.
- [retrieval.md](./retrieval.md): automatic recall, tool-mediated recall,
  hybrid ranking, automatic injection mechanics, and performance strategy.
- [extraction.md](./extraction.md): passive observation, background extraction,
  storable-fact policy, semantic duplicate detection, and supersession.
- [tools.md](./tools.md): model-visible memory management and recall tools.
- [admin.md](./admin.md): future operator/admin CLI command shape for memory
  inspection and repair.
- [verification.md](./verification.md): failure model, observability, and test
  requirements.

## User Stories

V1 memory must satisfy these product stories:

1. As a requester, I can ask Junior to remember a public/shareable first-person
   fact about me and have Junior recall it for me later.
2. As a requester, I cannot create a personal memory about another person,
   because personal user-subject memories are owned by the current
   author/requester.
3. As a public conversation participant, I can ask Junior to remember shared
   operational knowledge for that conversation.
4. As a requester, I can list, search, and remove memories visible in the
   current context without giving the model actor ids, Slack ids, or arbitrary
   scope selectors.
5. As an installer, I can enable memory knowing private, sensitive, and secret
   content is rejected rather than stored with a dormant classification.
6. As an operator, I can add embeddings, lexical indexes, or future graph
   indexes as derived data without changing the authoritative memory ownership
   model.

## Design Inputs

The V1 shape is informed by `~/src/ash/specs/memory/*` and a prior-art pass over
qmd, Mem0/OpenMemory, Supermemory, Zep/Graphiti, Cognee, Letta, and MemU. The
common durable-storage pattern is an authoritative scoped memory row plus
derived retrieval indexes, source attribution, lifecycle state, and optional
versioning or graph layers. V1 uses Ash's useful type taxonomy, centralized
secret rejection, temporal rewriting, and lifecycle/supersession discipline,
but does not copy Ash's sensitivity split, exact-content dedupe, or person
graph.

Future graph/entity/fact indexes should be derived from authoritative memory
records and source attribution. They can be added as separate rebuildable tables
without changing the V1 memory row's authority model.

External storage and retrieval assumptions are based on primary documentation:

- [pgvector](https://github.com/pgvector/pgvector) for Postgres-native vector
  columns, exact nearest-neighbor search, and HNSW/IVFFlat indexes.
- [Neon pgvector docs](https://neon.com/docs/extensions/pgvector) because
  Junior's SQL adapter targets Neon-compatible Postgres.
- [Drizzle PostgreSQL extension docs](https://orm.drizzle.team/docs/extensions/pg)
  for plugin-owned typed `vector` columns.
- [OpenAI embeddings docs](https://platform.openai.com/docs/guides/embeddings)
  for current embedding model and dimension behavior.

## Plugin Shape

The V1 memory implementation is a trusted host plugin registered through
`defineJuniorPlugin({ manifest, database, hooks })`.

The plugin uses the package name and plugin name `memory`. Plugin database
tables use the prefix:

```txt
junior_memory_*
```

The V1 runtime plugin interface is:

```ts
defineJuniorPlugin({
  manifest,
  database: {},
  hooks: {
    userPrompt,
    observeTurn,
    tasks: {
      extractMemories,
      embedMemories,
    },
    tools,
  },
});
```

`embedMemories` may be implemented as the same internal handler as extraction
backfill, but it is named separately so embedding repair can be queued without
pretending a completed turn needs to be re-extracted.

The exact hook and task type names are owned by their generic plugin specs. The
memory plugin needs these broad V1 surfaces: optional automatic recall,
completed-turn observation, background task handling, model-visible memory
tools, SQL access, and host-owned embedding-provider access. A future admin CLI
surface is specified separately in [`./admin.md`](./admin.md).

The plugin must also receive install-level memory policy before hooks execute.
Policy controls whether passive extraction is enabled, whether automatic memory
injection is enabled, what categories and scopes may be stored, which providers
may receive memory text, and which retention defaults apply.

V1 passive extraction targets workplace knowledge from conversations classified
as `public` by Junior's existing conversation privacy/destination visibility
contracts. Private, direct, unknown, or unsupported sources can still use
explicit memory tools for public/shareable memories when policy allows them,
but passive learning from those sources is out of scope for V1.

V1 uses the default extraction guidance in `policy.md`. Install-provided
extraction guidelines are out of scope for V1.

The plugin owns:

- its Drizzle table objects
- generated SQL migrations under `migrations/*.sql`
- a small memory store module around `ctx.db`
- extraction and retrieval policy
- install-level memory policy evaluation
- the `extractMemories` and embedding repair task handlers
- memory tool definitions
- future memory admin command definitions

Core owns:

- plugin loading and hook ordering
- prompt rendering and size limits
- database migration application
- runtime identity, source, and destination context
- plugin task enqueueing, retry, redelivery, and worker execution
- model and embedding provider credential custody
- tool schema validation and tool execution boundaries
- plugin config loading
- log, trace, and dashboard redaction

## Memory Types

The plugin stores one `type` for lifecycle and rendering policy:

| Type           | Meaning                                            | Default TTL |
| -------------- | -------------------------------------------------- | ----------- |
| `preference`   | Stable user or conversation preference             | none        |
| `identity`     | Stable fact about the requester                    | none        |
| `relationship` | Stable fact about a named person or relationship   | none        |
| `knowledge`    | Durable project, workspace, or domain fact         | none        |
| `context`      | Current situation that should decay                | 7 days      |
| `event`        | Dated occurrence that may matter later             | 30 days     |
| `task`         | Remembered obligation that is not a scheduled task | 14 days     |
| `observation`  | Low-durability observation                         | 3 days      |

Explicit scheduled work belongs to the scheduler plugin, not memory. A memory
of type `task` is only a remembered fact unless the user explicitly creates a
scheduled task through the scheduler workflow.

V1 passive extraction must not create `identity` or `relationship` memories
about third parties. Those types are primarily for explicit personal memory,
such as the requester's own public/shareable preferences, identity facts, or
working relationships that pass policy.

## Scope Model

V1 supports two visibility scopes:

| Scope          | Stored authority                                 | Visible to                                   |
| -------------- | ------------------------------------------------ | -------------------------------------------- |
| `personal`     | current requester actor                          | same requester in compatible runtime context |
| `conversation` | current source/destination conversation identity | later turns in the same conversation         |

Rules:

1. Scope is derived from runtime context. Model-visible tool arguments never
   provide requester ids, team ids, channel ids, thread ids, or conversation ids.
2. Personal memory is the default for first-person facts in interactive turns.
   The current author/requester must be the subject of any personal-scoped
   identity, preference, or relationship fact. For example, `I am on the
billing team` may become a personal memory for that requester, while `David
is on the billing team` is not a valid personal memory when written by
   someone else.
3. Conversation memory may be created only when the user explicitly frames the
   fact as shared team/channel/conversation knowledge or the passive extractor
   can prove the fact is about the current conversation rather than a person.
4. V1 does not recall memories across unrelated conversations, even if display
   names or Slack users appear to match.
5. Subject fields describe what the memory is about; they do not broaden
   visibility beyond the stored scope.

## Subject Model

Scope answers who can see the memory. Subject answers what the memory is about.
V1 supports a small subject model rather than a graph:

| Subject type   | Meaning                                      | Subject key                                 |
| -------------- | -------------------------------------------- | ------------------------------------------- |
| `user`         | public/shareable fact about the current user | current requester actor key                 |
| `conversation` | norm or fact about the current conversation  | current source/destination conversation key |
| `general`      | project, product, repository, or domain fact | none                                        |

Rules:

1. `user` subject is allowed only for the current author/requester. V1 does not
   let one participant create another user's personal profile memory.
2. `conversation` subject is derived from the current runtime conversation.
3. `general` subject is for public/shareable operational or domain knowledge
   that is not primarily about a person or the conversation itself.
4. Subject keys are runtime-derived internal storage fields when present.
   Model-visible tool arguments cannot provide arbitrary user ids, actor ids,
   conversation ids, aliases, or display names as subjects.
5. Subject fields may be used for rendering, filtering, ranking, and future
   derived graph construction, but authorization still comes from scope.
6. Third-party operational facts may appear in conversation-scoped `general`
   memories when policy allows them, but V1 does not create `user` subject
   memories for third parties.

## Public-Only Content

V1 does not store a sensitivity, classification, or privacy label on memory
records. A memory is eligible only if the accepted content is safe to recall
inside its stored scope without special private/sensitive handling.

Rules:

1. `personal` scope means requester-owned visibility for public/shareable
   first-person memories authored by that requester. It does not mean the
   content may be private, sensitive, secret, or third-party profile data.
2. `conversation` scope means the memory may be recalled in the same
   conversation. It must be appropriate as shared conversation knowledge.
3. Secrets are rejected and never stored.
4. Sensitive or private personal facts are rejected in V1, including explicit
   user requests.
5. If Junior later supports non-public memory, it must add an intentional
   storage, retrieval, prompt, admin, export, and deletion contract. Existing V1
   rows can be deterministically treated as public/shareable rows.

## Store Boundary

Hook bodies must not issue ad hoc SQL directly. The plugin should keep storage
behind a small store such as `MemoryStore`.

The store boundary owns:

- parsing database rows into memory records
- rejecting invalid enum values and malformed rows
- visibility filtering
- create/archive/list operations
- extraction idempotency
- embedding row repair
- expiration and supersession updates

Drizzle table objects may be imported inside the plugin package. They must not
be exported as part of Junior core.

## Implementation Order

Implement in this order:

1. Core plugin hook surfaces needed by this spec: `userPrompt`, `observeTurn`,
   plugin background tasks, `tools`, `ctx.db`, host embedding provider access,
   and plugin config/policy access.
2. Memory plugin package with manifest, schema, migrations, store, and
   install-level policy evaluator.
3. Explicit `createMemory`, `listMemories`, `searchMemories`, and
   `removeMemory` tools with context-bound scope and secret rejection.
4. Automatic recall from stored memories through `userPrompt` when
   `autoInjectMemories` is enabled, using lexical ranking before embeddings are
   available.
5. Embedding provider integration, vector storage, and embedding repair tasks.
6. `observeTurn` task enqueueing and `extractMemories` task execution.
7. Deduplication, TTL archival, and conservative supersession.
8. Optional vector index tuning and hybrid ranking improvements.
9. Future admin CLI inspection and repair commands after redaction and access
   rules are implemented.
10. Dashboard/admin UI only after a separate UI access-control contract exists.

The first vertical slice should prove explicit memory create/list/remove/search
and optional automatic memory injection before adding automatic extraction.

## Related Specs

- `../plugin.md`
- `../plugin-runtime.md`
- `../plugin-prompt-hooks.md`
- `../plugin-database.md`
- `../plugin-cli.md`
- `./policy.md`
- `../task-execution.md`
- `../identity.md`
- `../credential-injection.md`
- `../data-redaction-policy.md`
- `../agent-prompt.md`
- `../testing.md`
