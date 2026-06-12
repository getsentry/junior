# Plugin Database Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-12

## Purpose

Define how explicitly enabled plugins extend Junior's shared SQL database with
packaged migrations and access that database from trusted runtime hooks without
requiring a memory-specific storage API or a globally merged plugin schema type.

## Scope

- Plugin package migration layout and discovery.
- Plugin-owned migration generation workflow.
- Migration ordering, checksums, and application through `junior upgrade`.
- The `ctx.db` surface exposed to trusted plugin hooks.
- Drizzle table ownership and typing boundaries for plugin code.
- Required/optional database behavior for plugins.

## Non-Goals

- Auto-discovering TypeScript schema files by convention.
- Generating plugin migrations from the host app.
- Applying migrations from request handlers or plugin hooks.
- Providing a database sandbox for untrusted plugin code.
- Exposing a globally typed Drizzle schema containing every installed plugin
  table.
- Defining memory's concrete table schema.

## Contracts

### Package Shape

Plugins may include SQL migrations by convention:

```txt
plugin-package/
├── plugin.yaml
├── migrations/
│   ├── 0001_init.sql
│   └── 0002_add_indexes.sql
└── src/
    └── db/
        └── schema.ts
```

`migrations/*.sql` is the runtime migration artifact. `src/db/schema.ts` is a
plugin-owned authoring and typing convention, not a file Junior auto-discovers
at runtime.

Local app plugins may use the same shape under `plugins/<name>/migrations/`.
Package plugins must include migration files in their published package.

### Migration Discovery

Junior discovers migrations only for explicitly enabled plugins:

1. Local plugin roots declared by the app.
2. Plugin packages listed in `defineJuniorPlugins([...])`.
3. Code plugin registrations with an associated `packageName`.

Junior must never scan arbitrary `node_modules`, package dependencies, or
undeclared directories for migrations.

Build packaging must copy or trace declared plugin `migrations/` directories
alongside plugin manifests and skills so `junior upgrade` can read the same
migration files in production output.

### Migration Generation

Plugin packages own their own schema authoring and migration generation.

A plugin that uses Drizzle should keep its table objects and Drizzle config in
the plugin package and generate SQL into that plugin's `migrations/` directory.
For example:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate --config drizzle.config.ts"
  }
}
```

Rules:

1. Core does not generate plugin migrations.
2. Plugin migrations are generated from plugin-owned schema only.
3. Generated SQL files are committed and published as plugin package content.
4. Drizzle generation metadata may exist in the plugin package for future
   plugin development, but Junior applies only `migrations/*.sql`.
5. A plugin package must not require the consuming app to run Drizzle Kit to use
   the published plugin.

### Migration Application

`junior upgrade` applies database migrations in this order:

1. Core Junior migrations.
2. Plugin migrations, ordered by plugin name.
3. Migration files within each plugin, ordered lexically by filename.

Plugin migration records use the shared `junior_schema_migrations` table. The
stored migration id is:

```txt
plugin:<pluginName>/<filename>
```

Core computes the checksum from the exact SQL file contents. If a migration id
already exists with a different checksum, upgrade must fail.

Migration filenames must be stable, non-empty basenames ending in `.sql`.
Subdirectories are not part of V1 migration discovery.

### Migration Safety

Plugin migrations are privileged host code. The primary trust boundary is
explicit plugin installation and code review, not SQL sandboxing.

V1 plugin migrations must be expand-only:

- create plugin-owned tables
- add nullable columns to plugin-owned tables
- add indexes to plugin-owned tables
- add compatible constraints after existing data is clean

V1 plugin migrations must not:

- drop tables or columns
- rewrite large tables synchronously
- mutate core tables
- mutate another plugin's tables
- create triggers or background jobs outside the plugin's ownership boundary
- depend on request-time execution

Plugin-owned table names must use a deterministic prefix:

```txt
junior_<pluginName>_*
```

For plugin names containing hyphens, the SQL table prefix replaces hyphens with
underscores. For example, plugin `long-memory` owns
`junior_long_memory_*`.

Core may perform best-effort validation that migration SQL only references the
plugin-owned prefix, but validation is not a security boundary.

### Runtime DB Access

Trusted runtime hook contexts may expose `ctx.db` when all of these are true:

1. A Junior SQL database URL is configured.
2. The plugin is explicitly enabled.
3. The plugin's migrations, when present, have been applied successfully.
4. The hook is running in host runtime code, not sandboxed model-controlled
   code.

The V1 surface is a shared database connection/query capability:

```ts
interface AgentPluginDb {
  select: JuniorDrizzleConnection["select"];
  insert: JuniorDrizzleConnection["insert"];
  update: JuniorDrizzleConnection["update"];
  delete: JuniorDrizzleConnection["delete"];
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  query<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  transaction<T>(callback: (tx: AgentPluginDb) => Promise<T>): Promise<T>;
}
```

Hook contexts should expose this as `ctx.db`, not `ctx.database` or `ctx.db.db`.

`ctx.db` is not model-visible and must not be exposed to sandbox tools, skill
text, MCP tools, or tool input schemas.

### Drizzle Typing Boundary

Plugins own their table objects and row types.

Plugin code can import its own Drizzle table objects and use them with
`ctx.db`:

```ts
import { memories } from "./db/schema";

const rows = await ctx.db.select().from(memories);
```

The table object carries the row type for plugin queries. Core does not need to
merge plugin schemas into `juniorSqlSchema` for this query style to be typed.

V1 does not support:

- auto-importing `src/db/schema.ts` by convention
- `ctx.db.query.<pluginTable>` relation helpers for plugin tables
- a public type that represents every installed plugin table

If a future plugin needs globally composed Drizzle schema typing, that must be
added through an explicit code registration contract, not filesystem
auto-discovery.

### Required And Optional Database Plugins

Plugins that depend on SQL should declare whether database access is required
through code registration:

```ts
defineJuniorPlugin({
  manifest,
  database: {
    required: true,
  },
  hooks,
});
```

Rules:

1. `required: true` means startup and `junior upgrade` fail when Junior cannot
   resolve a SQL database URL or apply the plugin's migrations.
2. `required: false` or omitted means hooks may run without `ctx.db`; the plugin
   must disable database-backed behavior or surface an operational report
   explaining that storage is unavailable.
3. Declarative `plugin.yaml` cannot declare executable database behavior.

### Store Boundaries

Plugin hooks should not scatter ad hoc SQL throughout hook bodies. A plugin
should keep database access behind a small plugin-owned store module, such as a
memory store for the memory plugin.

Plugin stores must parse database rows at their boundary before returning
domain records. Drizzle table types are compile-time help, not runtime
validation for data read from the database.

## Failure Model

1. Missing required database URL: `junior upgrade` and startup fail for required
   database plugins.
2. Missing optional database URL: plugin hooks receive no `ctx.db`; plugin
   database-backed behavior is disabled.
3. Migration discovery failure for an enabled plugin: upgrade fails.
4. Migration checksum mismatch: upgrade fails.
5. Plugin migration SQL failure: upgrade fails before the new runtime serves
   traffic.
6. Runtime observes unapplied required plugin migrations: startup fails or the
   plugin is disabled before hooks execute.
7. Plugin database query failure during a hook: the hook fails according to its
   owning hook spec; prompt and observation hooks must fail closed with safe
   logging.

## Observability

Plugin database logs and spans may include:

- plugin name
- migration filename and migration id
- checksum prefix
- migration count
- migration outcome and duration
- database availability state
- plugin store operation name and duration

Logs and spans must not include raw private memory content, private
conversation text, credentials, authorization URLs, SQL parameter values that
may contain private user data, or raw query result payloads.

## Verification

Use integration tests with the local Postgres-compatible PGlite fixture for:

- discovery of `migrations/*.sql` from explicitly configured plugin packages
- no discovery from undeclared packages
- migration id/checksum recording in `junior_schema_migrations`
- deterministic plugin migration order
- checksum mismatch failure
- required database plugin failure when no SQL URL is configured
- optional database plugin behavior without `ctx.db`
- typed plugin table queries using plugin-owned Drizzle table objects

Use unit tests for:

- migration filename validation
- table-prefix derivation from plugin names
- build/package discovery including `migrations/`
- `ctx.db` presence checks in hook context construction

No evals are required for the database extension mechanism itself.

## Related Specs

- `./conversation-storage.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-prompt-hooks.md`
- `./plugin-heartbeat.md`
- `./testing.md`
