---
title: Memory Plugin
description: Configure the memory plugin for persistent long-term memory storage and recall.
type: tutorial
summary: Set up pgvector-backed memory storage so Junior can recall preferences and context across conversations.
prerequisites:
  - /extend/
related:
  - /reference/config-and-env/
  - /start-here/quickstart/
---

The memory plugin uses a Postgres database with the pgvector extension to store and retrieve long-term memories across conversations. Before each user turn, Junior combines semantic and full-text matches and includes only memories that directly help with the current request. The plugin also exposes explicit memory tools (remember, list, search, remove) and passively extracts memories from completed sessions in public Conversations.

All memories are public. Junior recalls them in every Conversation, but it stores new memories only in public Conversations. In private Conversations, such as DMs and private channels, the remember and remove tools are not available and passive extraction does not run.

New apps created with `junior init` include `memoryPlugin()` in `plugins.ts` by default.

## Prerequisites

Provision a Postgres database with pgvector support before running migrations. The memory plugin migrations create the `vector` and `btree_gin` extensions, store 1024- or 1536-dimensional embeddings, maintain a scope-aware full-text search index, and create an HNSW cosine index on 1024-dimensional embeddings for hybrid recall. Vector search on 1536-dimensional embeddings scans the matching rows without an index. Most managed Postgres providers — Neon, Supabase, Railway, and AWS RDS/Aurora PostgreSQL with pgvector enabled — support this out of the box.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-memory
```

## Runtime setup

The memory plugin requires a factory function call to register its tools and session hooks. Add `memoryPlugin()` to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { memoryPlugin } from "@sentry/junior-memory";

export const plugins = defineJuniorPlugins([memoryPlugin()]);
```

Do not register `@sentry/junior-memory` as a bare package-name string. The memory plugin uses `defineJuniorPlugin` with runtime hooks for tool registration and session processing; a bare string skips those hooks and the plugin will not activate its runtime behavior.

## Config

Pass plugin options to `memoryPlugin({ ... })` in `plugins.ts`. Set deployment variables in the Junior environment, then redeploy.

### Plugin options

<details class="plugin-config">
<summary><code>modelId</code></summary>

Model used for memory classification and consolidation.

- **Define:** `memoryPlugin({ modelId: "anthropic/claude-sonnet-4-5" })` in `plugins.ts`
- **Default:** The app's structured model
- **Required:** No
- **Environment override:** `AI_MEMORY_MODEL`; the plugin option takes precedence

</details>

<details class="plugin-config">
<summary><code>disableRecall</code></summary>

Disables automatic prompt recall while keeping explicit memory tools available.

- **Define:** `memoryPlugin({ disableRecall: true })` in `plugins.ts`
- **Default:** `false`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>disableExtraction</code></summary>

Disables passive memory extraction from completed sessions while keeping explicit memory tools available.

- **Define:** `memoryPlugin({ disableExtraction: true })` in `plugins.ts`
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

The plugin also exposes authenticated REST resources:

| Method   | Path                               | Purpose                                       |
| -------- | ---------------------------------- | --------------------------------------------- |
| `GET`    | `/api/plugins/memory/dashboard`    | Read memory totals and timeline               |
| `GET`    | `/api/plugins/memory/memories`     | List memories with `q`, `cursor`, and `limit` |
| `GET`    | `/api/plugins/memory/memories/:id` | Read one memory                               |
| `DELETE` | `/api/plugins/memory/memories/:id` | Forget one memory                             |

Personal API tokens can use the read endpoints. Deletion requires an
authenticated dashboard browser session.

## Migrations

The next Vercel deploy applies the memory plugin schema, because the scaffolded
build runs [junior upgrade](/cli/upgrade/). For a local database, run
`pnpm exec junior upgrade` yourself.

On a fresh database, the migrations create the `vector` and `btree_gin` extensions, the `junior_memory_memories` table, and the `junior_memory_embeddings` table with a `vector` column plus an HNSW cosine index for 1024-dimensional vectors.

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

Memories are public. A durable fact remembered in a public Conversation can be recalled from any Conversation, including DMs, web Conversations, and other Slack workspaces. The upgrade deletes private memories from older versions.

## Failure modes

- **Plugin not active after registration**: `@sentry/junior-memory` was registered as a bare string instead of `memoryPlugin()`. Switch to the factory call and redeploy.
- **Migration error — extension "vector" does not exist**: the Postgres database does not have pgvector available. Use a provider that supports pgvector or install it manually with `CREATE EXTENSION vector`.
- **Migration error — extension "btree_gin" does not exist**: the Postgres database does not include the standard `btree_gin` extension. Enable it with your provider or install it manually with `CREATE EXTENSION btree_gin`.
- **`DATABASE_URL` is required**: no database URL is configured. Set it in the deployment environment.
- **Connection errors on non-Neon Postgres**: set `JUNIOR_DATABASE_DRIVER=postgres` for Railway, Supabase, AWS RDS, or self-hosted Postgres.
- **Vector recall misses memories after a model change**: the heartbeat has not embedded all memories with the new model yet. Wait a few minutes. Look for `plugin.heartbeat.failed` in the logs if it does not finish.
- **Unsupported embedding vector size**: the model returns vectors that are not 1024 or 1536 numbers long. Pick a model or output size that matches.
- **Memories not recalled**: first confirm that the last deploy build log shows `junior upgrade` succeeded. If migrations are current, the memories may be outside the configured vector distance, or their reranking score may be below the recall threshold. Look for `memory_recall_rerank_failed` in the logs.

## Next step

Read [Config & Env Reference](/reference/config-and-env/) for the full list of database and model environment variables.
