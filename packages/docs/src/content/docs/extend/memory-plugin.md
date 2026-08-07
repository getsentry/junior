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

The memory plugin uses a Postgres database with the pgvector extension to store and retrieve long-term memories across conversations. Before each user turn, Junior combines semantic and full-text matches and includes only memories that directly help with the current request. The plugin also exposes explicit memory tools (remember, list, search, remove) and passively extracts memories from completed public-channel and local sessions.

New apps created with `junior init` include `memoryPlugin()` in `plugins.ts` by default.

## Prerequisites

Provision a Postgres database with pgvector support before running migrations. The memory plugin migrations create the `vector` and `btree_gin` extensions, store 1536-dimensional embeddings, maintain a scope-aware full-text search index, and create an HNSW cosine index on embeddings for hybrid recall. Most managed Postgres providers — Neon, Supabase, Railway, and AWS RDS/Aurora PostgreSQL with pgvector enabled — support this out of the box.

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

Model used for memory classification, consolidation, and automatic recall relevance.

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

The model must produce 1536-dimensional vectors. Changing it after memories exist requires flushing `junior_memory_embeddings` so embeddings can be regenerated. Automatic recall's fixed `0.45` cosine distance cutoff is tuned for the default model.

</details>

## Manage personal memories

Signed-in users can search, page through, and forget their personal memories
from the top-level **Memories** dashboard page. The page shows viewer-scoped
memory totals, embedding coverage, and history on **Overview**. The separate
**Memories** view provides search and collections for preferences,
automatically learned memories, and explicitly saved memories. Each record
explains whether Junior learned it automatically or saved it because the user
asked. Overview groups the viewer's active memories by type and how they were
added. Forgetting archives the memory so Junior no longer recalls it.

The plugin also exposes authenticated REST resources:

| Method   | Path                               | Purpose                                       |
| -------- | ---------------------------------- | --------------------------------------------- |
| `GET`    | `/api/plugins/memory/dashboard`    | Read viewer-scoped memory totals and timeline |
| `GET`    | `/api/plugins/memory/memories`     | List memories with `q`, `cursor`, and `limit` |
| `GET`    | `/api/plugins/memory/memories/:id` | Read one personal memory                      |
| `DELETE` | `/api/plugins/memory/memories/:id` | Forget one personal memory                    |

Personal API tokens can use the read endpoints. Deletion requires an
authenticated dashboard browser session.

## Run migrations

After setting `DATABASE_URL`, run the upgrade command to apply the memory plugin schema:

```bash
pnpm junior upgrade
```

On a fresh database, this creates the `vector` and `btree_gin` extensions, the `junior_memory_memories` table, and the `junior_memory_embeddings` table with a `vector(1536)` column plus its HNSW cosine index.

## Verify

Confirm memory storage and recall work end to end. In a Slack conversation where Junior has actor context, ask Junior to store an explicit memory:

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

Public Slack channel memories are workspace-visible. A durable fact remembered in a public channel or public-channel thread can be recalled from another public channel in the same Slack workspace. Private Slack and local conversation memories remain scoped to their original conversation.

## Failure modes

- **Plugin not active after registration**: `@sentry/junior-memory` was registered as a bare string instead of `memoryPlugin()`. Switch to the factory call and redeploy.
- **Migration error — extension "vector" does not exist**: the Postgres database does not have pgvector available. Use a provider that supports pgvector or install it manually with `CREATE EXTENSION vector`.
- **Migration error — extension "btree_gin" does not exist**: the Postgres database does not include the standard `btree_gin` extension. Enable it with your provider or install it manually with `CREATE EXTENSION btree_gin`.
- **`DATABASE_URL` is required**: no database URL is configured. Set it in the deployment environment.
- **Connection errors on non-Neon Postgres**: set `JUNIOR_DATABASE_DRIVER=postgres` for Railway, Supabase, AWS RDS, or self-hosted Postgres.
- **Embedding dimension mismatch**: `AI_EMBEDDING_MODEL` was changed after memories were stored with a different model. Flush the `junior_memory_embeddings` table and re-run migrations to regenerate vectors with the new model.
- **Memories not recalled**: first run `pnpm junior upgrade` against the production database. If migrations are current, the memories may be outside the configured vector distance or may not be directly relevant to the request.

## Next step

Read [Config & Env Reference](/reference/config-and-env/) for the full list of database and model environment variables.
