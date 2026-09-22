---
title: Memory
description: Understand and configure Junior's long-term memory storage and recall.
type: conceptual
summary: Memory is built into @sentry/junior. It stores durable facts in Postgres with pgvector and recalls them across conversations.
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/config-and-env/
  - /cli/upgrade/
  - /concepts/data-and-privacy/
---

Memory is built into `@sentry/junior`. Every app gets it. You do not install or register a plugin for it.

Junior stores long-term memories in Postgres and uses the pgvector extension for semantic search. Before each user turn, Junior combines semantic and full-text matches. It includes only the memories that directly help with the current request. Junior also exposes explicit memory tools (remember, list, search, and forget). After a session completes, Junior can learn durable facts from it.

## Prerequisites

Junior requires the `vector` (pgvector) and `btree_gin` Postgres extensions on every database. `junior upgrade` enables them. If the database cannot enable them, the upgrade stops with a prerequisite error. Most managed Postgres providers support both extensions, including Neon, Supabase, Railway, and AWS RDS or Aurora PostgreSQL with pgvector enabled.

Memory stores 1536-dimensional embeddings. It keeps a scope-aware full-text search index and an HNSW cosine index on embeddings for hybrid recall.

## Configure

Pass Memory settings to `createApp({ memory })`:

```ts title="server.ts"
import { createApp } from "@sentry/junior";

const app = await createApp({
  memory: {
    disableExtraction: true,
  },
});
```

<details class="plugin-config">
<summary><code>modelId</code></summary>

Model for memory classification, consolidation, and automatic recall relevance.

- **Define:** `createApp({ memory: { modelId: "anthropic/claude-sonnet-4-5" } })`
- **Default:** The app's default model
- **Required:** No
- **Environment override:** `AI_MEMORY_MODEL`; the `modelId` setting takes precedence

</details>

<details class="plugin-config">
<summary><code>disableRecall</code></summary>

Stops automatic prompt recall. The explicit memory tools stay available.

- **Define:** `createApp({ memory: { disableRecall: true } })`
- **Default:** `false`
- **Required:** No

</details>

<details class="plugin-config">
<summary><code>disableExtraction</code></summary>

Stops passive memory extraction from completed sessions. The explicit memory tools stay available.

- **Define:** `createApp({ memory: { disableExtraction: true } })`
- **Default:** `false`
- **Required:** No

</details>

<details class="plugin-config">
<summary><code>enabled</code></summary>

Emergency switch that removes every Memory surface from the app, including tools, recall, extraction, routes, and the **Memories** page. Stored memories stay in the database.

- **Define:** `createApp({ memory: { enabled: false } })`
- **Default:** `true`
- **Required:** No

</details>

`disableRecall` and `disableExtraction` are independent.

### Environment variables

<details class="plugin-config">
<summary><code>AI_EMBEDDING_MODEL</code></summary>

Embedding model for vector search.

- **Define:** Set `AI_EMBEDDING_MODEL` in the deployment environment
- **Default:** `openai/text-embedding-3-small`
- **Required:** No

The model must produce 1536-dimensional vectors. If you change it after memories exist, flush `junior_memory_embeddings` so that Junior can make new embeddings. The fixed `0.45` cosine distance cutoff for automatic recall is tuned for the default model.

</details>

Memory uses the same `DATABASE_URL`, `JUNIOR_DATABASE_DRIVER`, and `JUNIOR_SQL_STATEMENT_TIMEOUT_MS` settings as the rest of Junior. See [Config & Env Reference](/reference/config-and-env/).

## Manage personal memories

Signed-in users can search, page through, and forget their personal memories
from the top-level **Memories** dashboard page. The page shows viewer-scoped
memory totals, embedding coverage, and history on **Overview**. The separate
**Memories** view provides search and collections for preferences,
automatically learned memories, and explicitly saved memories. Each record
explains whether Junior learned it automatically or saved it because the user
asked. Overview groups the viewer's active memories by type and how they were
added. Forgetting archives the memory so Junior no longer recalls it.

Junior also exposes authenticated REST resources:

| Method   | Path                                                 | Purpose                                       |
| -------- | ---------------------------------------------------- | --------------------------------------------- |
| `GET`    | `/api/memory/dashboard`                              | Read viewer-scoped memory totals and timeline |
| `GET`    | `/api/memory/memories`                               | List memories with `q`, `cursor`, and `limit` |
| `GET`    | `/api/memory/memories/:id`                           | Read one personal memory                      |
| `DELETE` | `/api/memory/memories/:id`                           | Forget one personal memory                    |
| `GET`    | `/api/memory/conversations/:conversationId/memories` | List memories captured from one Conversation  |

Personal API tokens can use the read endpoints. Deletion requires an
authenticated dashboard browser session.

The same resources stay available under `/api/plugins/memory/*` for one compatibility window. New clients should use `/api/memory/*`.

## Run migrations

After you set `DATABASE_URL`, run the upgrade command:

```bash
pnpm junior upgrade
```

On a fresh database, this enables the `vector` and `btree_gin` extensions and creates the `junior_memory_memories` and `junior_memory_embeddings` tables.

## Upgrade from `@sentry/junior-memory`

Earlier releases shipped Memory as the `@sentry/junior-memory` plugin. Core now owns the same tables, data, events, tools, and routes. The upgrade keeps every stored memory.

1. Stop old Junior workers.
2. Install the new `@sentry/junior` version.
3. Run `junior upgrade`. A core migration adopts the Memory schema. It reads the current schema and applies only the legacy changes that are missing. It does not change a database that already ran every plugin migration. The old plugin migration journal stays as an audit record.
4. Remove `memoryPlugin()` from `defineJuniorPlugins(...)`. Move its options to `createApp({ memory })`.
5. Remove `@sentry/junior-memory` from your dependencies.
6. Restart workers.

During the compatibility window, `@sentry/junior-memory` is a deprecated package. Its `memoryPlugin()` call is accepted and ignored, and Junior logs one deprecation warning at startup. Its options have no effect. Its other exports come from `@sentry/junior/memory`. A future breaking release removes the package, the old registration, and the `/api/plugins/memory/*` routes.

If you must roll back, go back to the compatibility release. Do not reverse the core migration or drop Memory tables. The compatibility release reads the same tables.

## Verify

Confirm that memory storage and recall work end to end. In a Slack conversation where Junior has actor context, ask Junior to store an explicit memory:

```text
Remember that I prefer concise bullet-point summaries
```

Then verify recall by listing memories directly:

```text
what memories do you have about me?
```

Junior should list the stored preference. To confirm cross-conversation recall, start a new conversation as the same actor and ask:

```text
What do you remember about my preferences?
```

Junior should recall the preference without prompting.

Public Slack channel memories are workspace-visible. Junior can recall a durable fact from a public channel or public-channel thread in another public channel of the same Slack workspace. Private memory belongs to one User.

## Failure modes

- **Upgrade error — Junior requires the Postgres extensions vector and btree_gin**: the database cannot enable one of the extensions. Use a provider that supports pgvector, or enable the extensions as a privileged user with `CREATE EXTENSION vector` and `CREATE EXTENSION btree_gin`. Then rerun `junior upgrade`.
- **Startup warning about `@sentry/junior-memory`**: the plugin set still includes `memoryPlugin()` or the package name. Remove it and move its options to `createApp({ memory })`.
- **Startup error — plugin name "memory" is reserved**: another plugin claims the `memory` name. Rename that plugin.
- **Connection errors on non-Neon Postgres**: set `JUNIOR_DATABASE_DRIVER=postgres` for Railway, Supabase, AWS RDS, or self-hosted Postgres.
- **Embedding dimension mismatch**: `AI_EMBEDDING_MODEL` changed after Junior stored memories with a different model. Flush the `junior_memory_embeddings` table so that Junior can make new embeddings.
- **Memories not recalled**: first run `pnpm junior upgrade` against the production database. If migrations are current, the memories may be outside the vector distance cutoff, or they may not directly help with the request.

## Next step

Read [Config & Env Reference](/reference/config-and-env/) for the full list of database and model environment variables.
