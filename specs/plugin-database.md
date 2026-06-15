# Plugin Database Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-13

## Purpose

Define how explicitly enabled plugins extend Junior's shared SQL database with
packaged migrations and access that database from trusted runtime hooks without
requiring a memory-specific storage API or a globally merged plugin schema type.

## Scope

- Plugin package migration layout and discovery.
- Plugin-owned migration generation workflow.
- Migration ordering, checksums, and application through `junior upgrade`.
- Plugin-owned storage migration hooks for moving existing plugin state into
  plugin SQL tables.
- The `ctx.db` surface exposed to trusted plugin hooks.
- Drizzle table ownership and typing boundaries for plugin code.
- Database behavior for plugins.

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

Code plugin packages may include SQL migrations by convention:

```txt
plugin-package/
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

Declarative `plugin.yaml` packages are a separate manifest-only shape. If they
are packaged next to `migrations/`, Junior treats those migration files as
inert. A database-backed code plugin package should expose JavaScript
registration and `migrations/` package content, not a same-plugin `plugin.yaml`
manifest that would also be loaded as a declarative plugin. Local `plugin.yaml`
roots do not contribute SQL migrations in V1.

### Migration Discovery

Junior applies migrations only for explicitly enabled code plugin registrations
that include a plugin `manifest.name` and an associated `packageName`.

Package-name plugins and local `plugin.yaml` roots have an empty applied
migration list. This keeps the migration identity tied to the JavaScript
registration name that owns database access and storage migration hooks.

Junior must never scan arbitrary `node_modules`, package dependencies, or
undeclared directories for migrations.

Build packaging may copy or trace declared plugin-package `migrations/`
directories alongside plugin manifests and skills so `junior upgrade` can read
the same files in production output when a named code registration applies
them. Copying a migration directory does not make a declarative package apply
schema migrations by itself.

### Migration Generation

Plugin packages own their own schema authoring and migration generation.
Core owns migration application. Plugins publish committed SQL artifacts; Junior
does not let plugins run their own migration runner.

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

### Schema Migration Application

`junior upgrade` applies database migrations in this order:

1. Core Junior migrations.
2. Plugin migrations, ordered by plugin name.
3. Migration files within each plugin, ordered lexically by filename.
4. Plugin storage migration hooks, ordered by plugin name.

Plugin migration records use the shared `junior_schema_migrations` table. The
stored migration id is:

```txt
plugin:<pluginName>/<filename>
```

Core computes the checksum from the exact SQL file contents. If a migration id
already exists with a different checksum, upgrade must fail.

Migration filenames must be stable, non-empty basenames matching
`NNNN_name.sql`, where `NNNN` is a zero-padded numeric prefix. This keeps
lexical filename ordering identical to migration order. Subdirectories are not
part of V1 migration discovery.

### Storage Migration Hooks

Schema migrations are not enough when an existing plugin has durable state in a
non-SQL store. A trusted runtime plugin may provide a storage migration hook:

```ts
defineJuniorPlugin({
  manifest,
  database: {},
  hooks: {
    async migrateStorage(ctx) {
      // Read old plugin-owned state through ctx.state.
      // Write plugin-owned SQL records through ctx.db.
      return {
        scanned,
        migrated,
        existing,
        missing,
      };
    },
  },
});
```

The hook runs only as part of `junior upgrade`, not request handling. Core
invokes it only after core schema migrations and all discovered plugin SQL
migrations have completed successfully. This guarantees the plugin can write to
the tables created by its own `migrations/*.sql`.

`junior upgrade` must resolve plugin registrations from the same configured
plugin set that runtime uses when that set is available. In deployed Nitro
output this means reading the virtual `#junior/config` plugin set; in tests or
programmatic callers this may be passed explicitly in the migration context.
Package-only declarative plugins do not contribute SQL schema migrations or
storage migration hooks. `@sentry/junior` core must not import plugin packages
to synthesize runtime registrations; database-backed plugins such as the
scheduler must be enabled through the same JavaScript registration module used
by runtime.

The hook context is intentionally narrow:

```ts
interface StorageMigrationContext extends PluginContext {
  db: PluginDb;
  state: PluginState;
}
```

Rules:

1. `migrateStorage` hooks are JavaScript registration hooks. Declarative
   `plugin.yaml` manifests cannot register upgrade behavior.
2. Core must not invoke a `migrateStorage` hook for a plugin registration that
   was not explicitly enabled in the active plugin set.
3. `migrateStorage` hooks must be idempotent. Re-running `junior upgrade` must not
   duplicate rows, corrupt state, or require deleting old state first.
4. `migrateStorage` hooks should read and write plugin-owned state and
   plugin-owned SQL tables. Plugins are trusted host code; core does not
   enforce this ownership boundary.
5. `migrateStorage` hooks must use `ctx.db` for SQL writes. A plugin with a
   `migrateStorage` hook must declare database access and must fail upgrade
   before the hook runs if no SQL database is configured.
6. `migrateStorage` hooks may read existing plugin state through `ctx.state`. This is
   the only V1 bridge from pre-SQL plugin state into SQL.
7. `migrateStorage` hooks must return migration counters using the same result shape
   as core migrations: `scanned`, `migrated`, `existing`, `missing`, and
   optional `skipped`.
8. Core must run hooks sequentially in deterministic plugin-name order. V1 does
   not provide dependency ordering between plugin storage migrations.
9. A thrown upgrade hook error fails `junior upgrade`. The new deployment should
   not serve traffic until the failing plugin is fixed or disabled.
10. Storage migration hooks are not heartbeat hooks, background tasks, or admin commands.
    They must not enqueue model work, dispatch agents, call provider APIs, or
    depend on request-time context.
11. Storage migration hook logs must not include raw private conversation text, raw memory
    content, credentials, SQL parameters, or existing state payloads.

The scheduler plugin is the first expected consumer: it moves old
`junior:scheduler:*` plugin-state records into scheduler-owned SQL tables while
keeping the scheduler store interface stable.

### Migration Safety

Plugin migrations are privileged host code. The primary trust boundary is
explicit plugin installation and code review, not SQL sandboxing.

V1 plugin migrations must be expand-only:

- create plugin-owned tables
- add nullable columns to plugin-owned tables
- add indexes to plugin-owned tables
- add compatible constraints after existing data is clean

Trusted plugin migrations should not:

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

Core does not parse or validate plugin migration SQL for ownership. The prefix
is a convention for plugin authors and reviewers, not a runtime security
boundary.

### Runtime DB Access

Trusted runtime hook contexts may expose `ctx.db` when all of these are true:

1. A Junior SQL database URL is configured.
2. The plugin is explicitly enabled.
3. The plugin declared database access through code registration.
4. The hook is running in host runtime code, not sandboxed model-controlled
   code.

Runtime does not validate plugin migration state before creating `ctx.db`.
`junior upgrade` is the only command that applies plugin migrations and checks
stored migration checksums. Deployments must run `junior upgrade` before serving
traffic for a build that enables or changes database-backed plugins.

The V1 surface is a shared database connection/query capability:

```ts
interface PluginDb {
  select: JuniorDrizzleConnection["select"];
  insert: JuniorDrizzleConnection["insert"];
  update: JuniorDrizzleConnection["update"];
  delete: JuniorDrizzleConnection["delete"];
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  query<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  transaction<T>(callback: (tx: PluginDb) => Promise<T>): Promise<T>;
}
```

Hook contexts should expose this as `ctx.db`, not `ctx.database` or a nested
`ctx.db.db`.

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

### Database Plugins

Junior deployments require a SQL database. Plugins that use SQL still declare
database access through code registration so runtime contexts know whether to
expose `ctx.db`:

```ts
defineJuniorPlugin({
  manifest,
  database: {},
  hooks,
});
```

Rules:

1. Runtime and `junior upgrade` fail when Junior cannot resolve a SQL database
   URL.
2. A plugin receives `ctx.db` only when it declares database access through code
   registration.
3. Migration application and checksum validation happen only in `junior
upgrade`.
4. Declarative `plugin.yaml` cannot declare executable database behavior.

### Store Boundaries

Plugin hooks should not scatter ad hoc SQL throughout hook bodies. A plugin
should keep database access behind a small plugin-owned store module, such as a
memory store for the memory plugin.

Plugin stores must parse database rows at their boundary before returning
domain records. Drizzle table types are compile-time help, not runtime
validation for data read from the database.

## Failure Model

1. Missing database URL: `junior upgrade` and startup fail.
2. Migration discovery failure for an enabled plugin: upgrade fails.
3. Migration checksum mismatch: upgrade fails.
4. Plugin migration SQL failure: upgrade fails before the new runtime serves
   traffic.
5. Plugin storage migration hook failure: upgrade fails after schema migration and
   before the new runtime serves traffic.
6. Plugin database query failure during a hook: the hook fails according to its
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
- plugin storage migration outcome and duration

Logs and spans must not include raw private memory content, private
conversation text, credentials, authorization URLs, SQL parameter values that
may contain private user data, or raw query result payloads.

## Verification

Use integration tests with the local Postgres-compatible PGlite fixture for:

- migration application from named code plugin registrations with package
  `migrations/*.sql`
- no discovery from undeclared packages
- no migration application from package-name or local `plugin.yaml` plugins
- migration id/checksum recording in `junior_schema_migrations`
- deterministic plugin migration order
- checksum mismatch failure
- missing database URL failure
- plugins without database declarations do not receive `ctx.db`
- typed plugin table queries using plugin-owned Drizzle table objects
- plugin storage migration hooks run after plugin schema migrations
- plugin storage migration hooks are idempotent across repeated upgrade runs

Use unit tests for:

- migration filename validation
- table-prefix derivation from plugin names
- build/package bundling including `migrations/`
- `ctx.db` presence checks in hook context construction

No evals are required for the database extension mechanism itself.

## Related Specs

- `./conversation-storage.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-prompt-hooks.md`
- `./memory-plugin/index.md`
- `./plugin-heartbeat.md`
- `./testing.md`
