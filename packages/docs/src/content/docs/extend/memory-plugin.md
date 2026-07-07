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

The memory plugin uses a Postgres database with the pgvector extension to store and retrieve long-term memories across conversations. Junior recalls relevant memories before each user turn, exposes explicit memory tools (remember, list, search, remove), and passively extracts memories from completed public-channel and local sessions.

New apps created with `junior init` include `createMemoryPlugin()` in `plugins.ts` by default.

## Prerequisites

Provision a Postgres database with pgvector support before running migrations. The memory plugin migration creates the `vector` extension and stores 1536-dimensional embeddings. Most managed Postgres providers — Neon, Supabase, Railway, and AWS RDS/Aurora PostgreSQL with pgvector enabled — support this out of the box.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-memory
```

## Runtime setup

The memory plugin requires a factory function call to register its tools and session hooks. Add `createMemoryPlugin()` to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { createMemoryPlugin } from "@sentry/junior-memory";

export const plugins = defineJuniorPlugins([createMemoryPlugin()]);
```

Do not register `@sentry/junior-memory` as a bare package-name string. The memory plugin uses `defineJuniorPlugin` with runtime hooks for tool registration and session processing; a bare string skips those hooks and the plugin will not activate its runtime behavior.

Pass `modelId` to override the model used for memory classification and consolidation:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { createMemoryPlugin } from "@sentry/junior-memory";

export const plugins = defineJuniorPlugins([
  createMemoryPlugin({ modelId: "anthropic/claude-sonnet-4-5" }),
]);
```

## Configure environment variables

| Variable                            | Required | Purpose                                                                                                                                                                                                      |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                      | Yes      | Postgres connection string for memory storage.                                                                                                                                                               |
| `JUNIOR_DATABASE_DRIVER`            | No       | SQL client driver: `neon` (default) or `postgres`. Set `postgres` for non-Neon deployments.                                                                                                                  |
| `AI_EMBEDDING_MODEL`                | No       | Embedding model for vector search. Defaults to `openai/text-embedding-3-small` (1536 dims).                                                                                                                  |
| `AI_MEMORY_MODEL`                   | No       | Model for memory classification and consolidation. Defaults to the app's structured model.                                                                                                                   |
| `MEMORY_RECALL_MAX_VECTOR_DISTANCE` | No       | Maximum cosine distance for vector recall candidates. Values 0–1; lower = stricter. Values above 1 are clamped to 1. Default `0.45` suits `text-embedding-3-small`. Tune when changing `AI_EMBEDDING_MODEL`. |

`AI_EMBEDDING_MODEL` must produce 1536-dimensional vectors. Changing this value after memories exist requires flushing the `junior_memory_embeddings` table and re-running to regenerate vectors with the new model.

For non-Neon managed Postgres (Railway, Supabase, AWS RDS, or self-hosted), set `JUNIOR_DATABASE_DRIVER=postgres`. Local URLs (`localhost`, `127.0.0.1`) automatically use the `postgres` driver.

## Run migrations

After setting `DATABASE_URL`, run the upgrade command to apply the memory plugin schema:

```bash
pnpm junior upgrade
```

On a fresh database, this creates the `vector` extension, the `junior_memory_memories` table, and the `junior_memory_embeddings` table with a `vector(1536)` column.

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

- **Plugin not active after registration**: `@sentry/junior-memory` was registered as a bare string instead of `createMemoryPlugin()`. Switch to the factory call and redeploy.
- **Migration error — extension "vector" does not exist**: the Postgres database does not have pgvector available. Use a provider that supports pgvector or install it manually with `CREATE EXTENSION vector`.
- **`DATABASE_URL` is required**: no database URL is configured. Set it in the deployment environment.
- **Connection errors on non-Neon Postgres**: set `JUNIOR_DATABASE_DRIVER=postgres` for Railway, Supabase, AWS RDS, or self-hosted Postgres.
- **Embedding dimension mismatch**: `AI_EMBEDDING_MODEL` was changed after memories were stored with a different model. Flush the `junior_memory_embeddings` table and re-run migrations to regenerate vectors with the new model.
- **Memories not recalled**: the database migration has not run yet. Run `pnpm junior upgrade` against the production database.

## Next step

Read [Config & Env Reference](/reference/config-and-env/) for the full list of database and model environment variables.
