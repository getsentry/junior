# Plugin Database Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-28

## Purpose

Define how explicitly enabled plugins extend Junior's shared SQL database with
packaged migrations and access that database from plugin hooks without
requiring a memory-specific storage API or a globally merged plugin schema type.

## Scope

- Plugin package migration layout and discovery.
- Plugin-owned migration generation workflow.
- Migration ordering, journals, and application through `junior upgrade`.
- Plugin-owned storage migration hooks for moving existing plugin state into
  plugin SQL tables.
- The `ctx.db` surface exposed to plugin hooks.
- Drizzle table ownership and typing boundaries for plugin code.
- Database behavior for plugins.

## Non-Goals

- Auto-discovering TypeScript schema files by convention.
- Generating plugin migrations from the host app.
- Applying migrations from request handlers or plugin hooks.
- Providing a database sandbox for plugin code.
- Exposing a globally typed Drizzle schema containing every installed plugin
  table.
- Defining memory's concrete table schema.

## Contracts

### Package Shape

Code plugin packages may include SQL migrations by convention:

```txt
plugin-package/
├── migrations/
│   ├── 0000_init.sql
│   ├── 0001_add_indexes.sql
│   └── meta/
│       ├── 0000_snapshot.json
│       ├── 0001_snapshot.json
│       └── _journal.json
└── src/
    └── db/
        └── schema.ts
```

`migrations/*.sql` is the runtime migration artifact. `src/db/schema.ts` is a
plugin-owned authoring and typing convention, not a file Junior auto-discovers
at runtime.

Declarative `plugin.yaml` packages are a separate manifest-only shape. If they
are packaged next to `migrations/`, Junior treats those migration files as
inert. A SQL-owning code plugin package should expose JavaScript registration
and `migrations/` package content, not a same-plugin `plugin.yaml`
manifest that would also be loaded as a declarative plugin. Local `plugin.yaml`
roots do not contribute SQL migrations in V1.

### Migration Discovery

Junior applies migrations only for explicitly enabled code plugin registrations
that include a plugin `manifest.name` and an associated `packageName`.

Package-name plugins and local `plugin.yaml` roots have an empty applied
migration list. This keeps the migration identity tied to the JavaScript
registration name that owns SQL migrations and storage migration hooks.

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
4. Drizzle generation metadata is committed and published with the SQL files;
   Junior passes the complete folder to Drizzle ORM's migrator.
5. A plugin package must not require the consuming app to run Drizzle Kit to use
   the published plugin.
6. Schema DDL should come from the generator. Hand-written SQL in a generated
   migration must be limited to data rewrites needed to make the generated
   schema change safe, such as cleaning existing rows before adding a narrowed
   check constraint.

### Schema Migration Application

`junior upgrade` applies database migrations in this order:

1. Core Junior migrations.
2. Plugin migrations, ordered by plugin name.
3. Journal entries within each plugin, in Drizzle order.
4. Plugin storage migration hooks, ordered by plugin name.

Each plugin receives its own migration table in Drizzle's migration schema, so
independently generated plugin journals cannot advance or skip one another.
Junior passes the plugin folder and that table name directly to Drizzle ORM's
migrator. The pre-Drizzle shared migration table is read only to adopt already
deployed plugin schemas on their first upgrade through this cutover. One
Postgres advisory lock encloses the plugin's journal lookup, legacy adoption,
and Drizzle migration application.

### Storage Migration Hooks

Schema migrations are not enough when an existing plugin has durable state in a
non-SQL store. A plugin may provide a storage migration hook:

```ts
defineJuniorPlugin({
  manifest,
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
to synthesize runtime registrations; SQL-owning plugins such as the scheduler
must be enabled through the same JavaScript registration module used by runtime.

The hook context is intentionally narrow:

```ts
interface StorageMigrationContext extends PluginContext {
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
   plugin-owned SQL tables. Core does not enforce this ownership boundary.
5. `migrateStorage` hooks must use `ctx.db` for SQL writes. `junior upgrade`
   must fail before the hook runs if Junior cannot resolve a SQL database.
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

Plugin migrations are app-owned host code. The primary boundary is explicit
plugin installation and code review, not SQL sandboxing.

Code plugins that use `ctx.db` are app-owned runtime code. Core must not
introduce database facades solely to prevent plugins from accessing core tables
or schemas. Ownership rules are review and convention boundaries unless a
concrete security, migration, lifecycle, or model-visible boundary requires
enforcement.

V1 plugin migrations must be expand-only:

- create plugin-owned tables
- add nullable columns to plugin-owned tables
- add indexes to plugin-owned tables
- add compatible constraints after existing data is clean

Plugin migrations should not:

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

Plugin hook contexts expose `ctx.db`. Runtime provides the shared Junior SQL
database connection to every plugin hook context. Junior startup fails when it
cannot resolve a SQL database URL.

This surface is only for plugin hooks running in Junior host runtime code. It
must not be exposed to sandboxed model-controlled code.

Runtime does not validate plugin migration state before creating `ctx.db`.
`junior upgrade` is the only command that applies plugin migrations. Deployments
must run `junior upgrade` before serving
traffic for a build that enables or changes SQL-owning plugins.

The V1 runtime surface is the shared Junior Drizzle database connection. Hook
contexts expose this as `ctx.db`, not `ctx.database`, a nested `ctx.db.db`, or a
custom plugin database facade.

The public plugin API exposes `ctx.db` as `unknown`. Core does not wrap Drizzle
methods, publish a partial database facade, or try to compose every installed
plugin schema into one global type. A TypeScript plugin that wants typed
queries should locally type `ctx.db` against its own Drizzle schema at the
plugin boundary, then pass that typed connection into its plugin-owned store.

`ctx.db` is not model-visible and must not be exposed to sandbox tools, skill
text, MCP tools, or tool input schemas.

### Drizzle Typing Boundary

Plugins own their table objects and row types.

Plugin code can import its own Drizzle table objects, type the runtime database
against that schema, and use the typed connection in its store:

```ts
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { memories } from "./db/schema";
import * as schema from "./db/schema";

type MemoryDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const db = ctx.db as MemoryDb;
const rows = await db.select().from(memories);
```

The table object carries the row type for plugin queries. Core does not need to
merge plugin schemas into `juniorSqlSchema`, and plugin-api does not need a
Drizzle dependency, for this query style to be typed inside the plugin package.

V1 does not support:

- auto-importing `src/db/schema.ts` by convention
- `ctx.db.query.<pluginTable>` relation helpers for plugin tables
- a public type that represents every installed plugin table
- custom raw SQL helpers on `ctx.db` as a plugin-facing abstraction

If a future plugin needs globally composed Drizzle schema typing, that must be
added through an explicit code registration contract, not filesystem
auto-discovery.

### Plugin DB Access

Junior deployments require a SQL database. Hook contexts receive `ctx.db`
because JavaScript plugin registrations are app-owned runtime code. Plugins do
not declare a separate database capability.

Plugins that own SQL schema publish migrations through their package
`migrations/` directory and named JavaScript registration. Plugins that move
existing non-SQL state into SQL provide `hooks.migrateStorage`:

```ts
defineJuniorPlugin({
  manifest,
  hooks: {
    migrateStorage,
  },
});
```

Rules:

1. Runtime and `junior upgrade` fail when Junior cannot resolve a SQL database
   URL.
2. Plugin hook contexts receive `ctx.db` regardless of whether the plugin owns
   migrations.
3. Migration application happens only in `junior upgrade`.
4. Declarative `plugin.yaml` cannot declare executable database behavior.

### Store Boundaries

Plugin hooks should not scatter ad hoc SQL throughout hook bodies. A plugin
should keep database access behind a small plugin-owned store module, such as a
memory store for the memory plugin.

Plugin stores must parse database rows at their boundary before returning
domain records. Drizzle table types are compile-time help, not runtime
validation for data read from the database.

Core may keep lower-level SQL executor types for migrations, locks, raw catalog
queries, and connection lifecycle. Those executor types are not plugin hook
interfaces and must not be passed as `ctx.db`.

## Failure Model

1. Missing database URL: `junior upgrade` and startup fail.
2. Migration discovery failure for an enabled plugin: upgrade fails.
3. Missing or invalid Drizzle migration journal: upgrade fails.
4. Plugin migration SQL failure: upgrade fails before the new runtime serves
   traffic.
5. Plugin storage migration hook failure: upgrade fails after schema migration and
   before the new runtime serves traffic.
6. Plugin database query failure during a hook: the hook fails according to its
   owning hook spec; prompt hooks must fail closed with safe logging.

## Observability

Plugin database logs and spans may include:

- plugin name
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
- independent Drizzle migration state for each plugin
- deterministic plugin migration order
- invalid or missing migration journal failure
- missing database URL failure
- plugin hook contexts receive `ctx.db`
- typed plugin table queries using plugin-owned Drizzle table objects
- plugin storage migration hooks run after plugin schema migrations
- plugin storage migration hooks are idempotent across repeated upgrade runs

Do not add permanent feature-level tests for every generated schema or data
migration. Review and verify those migration artifacts directly: regenerate
from the owning schema, inspect the SQL for deploy safety, and run a targeted
upgrade probe when a data rewrite or constraint narrowing needs evidence. Keep
tests for migration ordering and isolation, storage
migration hooks, and explicit migration-contract surfaces.

Use unit tests for:

- migration filename validation
- table-prefix derivation from plugin names
- build/package bundling including `migrations/`

No evals are required for the database extension mechanism itself.

## Related Specs

- `./conversation-storage.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-prompt-hooks.md`
- `./memory-plugin/index.md`
- `./plugin-heartbeat.md`
- `./testing.md`
