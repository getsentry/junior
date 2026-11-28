---
title: Memory
description: Configure long-term memory storage and recall.
type: tutorial
summary: Set up pgvector-backed memory storage so Junior can recall preferences and context across conversations.
related:
  - /reference/config-and-env/
  - /start-here/quickstart/
---

Memory uses the Junior Postgres database with the pgvector extension to store and retrieve long-term memories across conversations. Memory is always on. Before each Turn, Junior searches with the request of that Turn: what a person wrote, the task of a parent agent, or the instructions of an automation. It combines semantic and full-text matches, and includes only memories that directly help with the current request. It skips memories that the Conversation history still holds: memories it already added since the last compaction, and memories captured from the same Conversation since then. Turns with no request, such as Events, timers, and child agent results, get no recalled memories. Junior also has explicit memory tools (remember, list, search, remove) and passively extracts memories from completed sessions in public Conversations.

All memories are public. Junior recalls them in every Conversation, but it stores new memories only in public Conversations. In private Conversations, such as DMs and private channels, the remember and remove tools are disabled and passive extraction does not run.

Passive extraction also retires stale memories. When a user message or a successful tool result in a Turn shows that a recalled memory is no longer true, Junior archives that memory. When a Turn says that a fact changed, such as a renamed option, the new memory replaces the old one, even when another Conversation taught the old one. The Turn's capture event in the transcript lists each archived memory and the reason, and the memory database records the reason and the Conversation that showed it. A retried write does not bring back an archived memory.

## Prerequisites

Provision a Postgres database with pgvector support before running migrations. The Memory migrations create the `vector` and `btree_gin` extensions, store 1024- or 1536-dimensional embeddings, maintain a scope-aware full-text search index, and create an HNSW cosine index on 1024-dimensional embeddings for hybrid recall. Vector search on 1536-dimensional embeddings scans the matching rows without an index. Most managed Postgres providers — Neon, Supabase, Railway, and AWS RDS/Aurora PostgreSQL with pgvector enabled — support this out of the box.

## Config

Pass Memory options to `createApp({ memory: { ... } })`. Set deployment variables in the Junior environment, then redeploy.

```ts title="server.ts"
const { app } = await createApp({
  memory: { modelId: "anthropic/claude-sonnet-4-5" },
});
```

### Options

<details class="plugin-config">
<summary><code>modelId</code></summary>

Model used for memory classification and consolidation.

- **Define:** `createApp({ memory: { modelId: "anthropic/claude-sonnet-4-5" } })`
- **Default:** The app's structured model
- **Required:** No
- **Environment override:** `AI_MEMORY_MODEL`; the option takes precedence

</details>

<details class="plugin-config">
<summary><code>disableRecall</code></summary>

Disables automatic prompt recall while keeping explicit memory tools available.

- **Define:** `createApp({ memory: { disableRecall: true } })`
- **Default:** `false`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>disableExtraction</code></summary>

Disables passive memory extraction from completed sessions while keeping explicit memory tools available.

- **Define:** `createApp({ memory: { disableExtraction: true } })`
- **Default:** `false`
- **Required:** No
- **Environment override:** None

</details>

### Environment variables

<details class="plugin-config">
<summary><code>DATABASE_URL</code></summary>

Postgres connection string for memory storage.

- **Define:** Set `DATABASE_URL` in the deployment environment
- **Required:** Yes
- **Environment override:** `DATABASE_URL`

The database must support pgvector.

</details>

<details class="plugin-config">
<summary><code>JUNIOR_DATABASE_DRIVER</code></summary>

SQL client driver for memory storage.

- **Define:** Set `JUNIOR_DATABASE_DRIVER` in the deployment environment
- **Default:** `neon`; local URLs automatically use `postgres`
- **Required:** No
- **Environment override:** `JUNIOR_DATABASE_DRIVER`

Use `postgres` for non-Neon managed Postgres such as Railway, Supabase, AWS RDS, or self-hosted Postgres.

</details>

<details class="plugin-config">
<summary><code>JUNIOR_SQL_STATEMENT_TIMEOUT_MS</code></summary>

Runtime PostgreSQL statement timeout in milliseconds.

- **Define:** Set `JUNIOR_SQL_STATEMENT_TIMEOUT_MS` in the deployment environment
- **Default:** `30000`; set `0` to disable
- **Required:** No
- **Environment override:** `JUNIOR_SQL_STATEMENT_TIMEOUT_MS`

</details>

<details class="plugin-config">
<summary><code>AI_EMBEDDING_MODEL</code></summary>

Embedding model used for vector search.

- **Define:** Set `AI_EMBEDDING_MODEL` in the deployment environment
- **Default:** `openai/text-embedding-3-small`
- **Required:** No
- **Environment override:** `AI_EMBEDDING_MODEL`

The model must produce 1024- or 1536-dimensional vectors. Junior stores one vector per memory for each model and only compares vectors from the same model, so you can change the model without data loss. Automatic recall's fixed `0.45` cosine distance cutoff is tuned for the default model.

To change the model after memories exist, set `AI_EMBEDDING_MODEL` to the new model and deploy. Each minute, the memory heartbeat embeds active memories that have no current vector for the configured model, in batches, for up to about 15 seconds. Until it finishes, vector search finds only the memories that it already embedded, and full-text search still finds all of them. The heartbeat also repairs vectors that a failed write left out.

To roll back, set `AI_EMBEDDING_MODEL` back to the old model. The old vectors stay until you delete them.

</details>

<details class="plugin-config">
<summary><code>AI_RERANKING_MODEL</code></summary>

Reranking model that scores recall candidates against the user's message.

- **Define:** Set `AI_RERANKING_MODEL` in the deployment environment
- **Default:** `voyage/rerank-2.5-lite`
- **Required:** No
- **Environment override:** `AI_RERANKING_MODEL`

Automatic recall adds a candidate to the prompt only when its score is at least `0.55`. This threshold is tuned for the default model. If the reranking call fails, the turn continues without recalled memories.

</details>

## Manage memories

Signed-in users can search, page through, and forget memories from the
top-level **Memories** dashboard page. **Overview** shows memory totals,
embedding coverage, and history, grouped by type and by how each memory was
added. The separate **Memories** view lists and searches memories. Each search
result marks the matched words. Each record tells whether Junior
learned it automatically or saved it because someone asked. Forgetting
archives the memory for everyone, so Junior no longer recalls it.

The **Archived** tab lists archived memories, with the date and the reason.
**Restore** makes one active again, so Junior recalls it again. In a public
Conversation, a person can also ask Junior to restore a memory.

Junior also exposes authenticated REST resources:

| Method   | Path                                       | Purpose                                                                     |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `GET`    | `/api/memory/dashboard`            | Read memory totals and timeline                                             |
| `GET`    | `/api/memory/memories`             | List memories with `q`, `cursor`, `limit`, and `archived=true` for archived |
| `GET`    | `/api/memory/memories/:id`         | Read one memory, or one archived memory with `archived=true`                |
| `DELETE` | `/api/memory/memories/:id`         | Forget one memory                                                           |
| `PATCH`  | `/api/memory/memories/:id`         | Set `archived`: `false` restores an archived memory, `true` forgets it     |

Personal API tokens can use the read endpoints. Forget and restore require an
authenticated dashboard browser session.

## Migrations

The next Vercel deploy applies the Memory schema, because the scaffolded
build runs [junior upgrade](/cli/upgrade/). For a local database, run
`pnpm exec junior upgrade` yourself.

On a fresh database, the migrations create the `vector` and `btree_gin` extensions, the `junior_memory_memories` table, and the `junior_memory_embeddings` table with a `vector` column plus an HNSW cosine index for 1024-dimensional vectors.

Through 0.310.0, Memory was the `@sentry/junior-memory` plugin. To upgrade an app that used it:

1. Remove `memoryPlugin()` from `plugins.ts` and remove the `@sentry/junior-memory` package.
2. Move the `memoryPlugin({ ... })` options to `createApp({ memory: { ... } })`.
3. Upgrade `@sentry/junior` and deploy. `junior upgrade` keeps the existing Memory tables and data.

Before you upgrade, run `junior upgrade` once with `@sentry/junior-memory` 0.310.0 or later, so that all of its migrations are applied. Otherwise `junior upgrade` stops with an error. After the upgrade, you can roll back to 0.310.0 with `@sentry/junior-memory` 0.310.0. A database that a later version created cannot roll back to 0.310.0 or earlier.

## Verify

Confirm memory storage and recall work end to end. In a public Slack channel where Junior has actor context, ask Junior to store an explicit memory:

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

Memories are public. A durable fact remembered in a public Conversation can be recalled from any Conversation, including DMs, Conversations outside Slack, and other Slack workspaces. The upgrade deletes private memories from older versions.

## Failure modes

- **Migration error — extension "vector" does not exist**: the Postgres database does not have pgvector available. Use a provider that supports pgvector or install it manually with `CREATE EXTENSION vector`.
- **Migration error — extension "btree_gin" does not exist**: the Postgres database does not include the standard `btree_gin` extension. Enable it with your provider or install it manually with `CREATE EXTENSION btree_gin`.
- **`DATABASE_URL` is required**: no database URL is configured. Set it in the deployment environment.
- **Connection errors on non-Neon Postgres**: set `JUNIOR_DATABASE_DRIVER=postgres` for Railway, Supabase, AWS RDS, or self-hosted Postgres.
- **Vector recall misses memories after a model change**: the heartbeat has not embedded all memories with the new model yet. Wait a few minutes. Look for `plugin.heartbeat.failed` in the logs if it does not finish.
- **Migration error — The Memory plugin migrations are not complete**: the database ran only part of the `@sentry/junior-memory` migrations. Run `junior upgrade` with `@sentry/junior` 0.310.0 and `@sentry/junior-memory` 0.310.0, then upgrade again.
- **Unsupported embedding vector size**: the model returns vectors that are not 1024 or 1536 numbers long. Pick a model or output size that matches.
- **Memories not recalled**: first confirm that the last deploy build log shows `junior upgrade` succeeded. If migrations are current, the memories may be outside the configured vector distance, their reranking score may be below the recall threshold, or the Conversation history may already hold them. Look for `memory_recall_rerank_failed` in the logs.

## Next step

Read [Config & Env Reference](/reference/config-and-env/) for the full list of database and model environment variables.
