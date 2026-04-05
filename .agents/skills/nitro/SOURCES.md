# Sources

Retrieved: 2026-04-04
Skill class: `integration-documentation`
Selected profile: `references/examples/documentation-skill.md`

## Source inventory

| Source                                                               | Trust tier | Confidence | Contribution                                                                     | Usage constraints                     |
| -------------------------------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| `node_modules/nitro/skills/nitro/docs/docs/routing.md`               | canonical  | high       | Filesystem routing, dynamic params, middleware, route rules, programmatic routes | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/configuration.md`         | canonical  | high       | Config file formats, env-specific config, directory options, runtime config      | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/config/index.md`               | canonical  | high       | Full config option reference (1,147 lines)                                       | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/cache.md`                 | canonical  | high       | defineCachedHandler, defineCachedFunction, SWR, cache keys, invalidation         | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/storage.md`               | canonical  | high       | useStorage API, drivers, mount points, server assets                             | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/database.md`              | canonical  | high       | useDatabase, SQL template literals, connectors, devDatabase                      | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/plugins.md`               | canonical  | high       | definePlugin, nitroApp context, runtime hooks, error capture                     | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/lifecycle.md`             | canonical  | high       | Request lifecycle order, error handling, hooks reference                         | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/server-entry.md`          | canonical  | high       | server.ts auto-detection, framework compatibility, config                        | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/tasks.md`                 | canonical  | high       | defineTask, scheduled tasks, task config                                         | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/assets.md`                | canonical  | high       | Public assets, server assets, compression                                        | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/migration.md`             | canonical  | high       | v2→v3 breaking changes, renamed APIs, preset updates                             | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/deploy/providers/vercel.md`    | canonical  | high       | Vercel preset, ISR, cron jobs, proxy rules, build output                         | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/deploy/index.md`               | canonical  | medium     | Deployment overview, zero-config providers, preset selection                     | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/deploy/runtimes/node.md`       | canonical  | medium     | Node.js preset, env vars, cluster mode                                           | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/hono.md`              | canonical  | high       | Hono framework integration example                                               | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/api-routes.md`        | canonical  | high       | Filesystem routing code examples                                                 | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/middleware.md`        | canonical  | high       | Middleware definition and context usage                                          | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/plugins.md`           | canonical  | high       | Plugin hooks and response modification                                           | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/cached-handler.md`    | canonical  | high       | Cache bypass pattern                                                             | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/websocket.md`         | canonical  | high       | WebSocket handler with pub/sub                                                   | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/runtime-config.md`    | canonical  | high       | Runtime config with env override                                                 | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/database.md`          | canonical  | high       | Database queries and migration tasks                                             | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/examples/vite-nitro-plugin.md` | canonical  | medium     | Vite plugin with virtual routes                                                  | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/renderer.md`              | canonical  | low        | HTML rendering, rendu preprocessor                                               | Vendored; niche feature, low priority |
| `node_modules/nitro/skills/nitro/docs/docs/index.md`                 | canonical  | medium     | Feature overview and landing page                                                | Vendored with nitro@3.0.260311-beta   |
| `node_modules/nitro/skills/nitro/docs/docs/quick-start.md`           | canonical  | medium     | Project setup steps                                                              | Vendored with nitro@3.0.260311-beta   |

## Decisions

| Decision                                               | Status  | Evidence                                                                           |
| ------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| Use web standard APIs exclusively for handler examples | adopted | migration.md: H3 v2 uses web Request/Response; all v2 utils deprecated             |
| Cover Vercel deployment in depth over other providers  | adopted | Most common deployment target in repo usage; vercel.md has ISR/cron/proxy features |
| Include migration reference table in troubleshooting   | adopted | migration.md: many v2→v3 breaking changes require lookup table                     |
| Mark database and tasks as experimental                | adopted | database.md, tasks.md: both require `experimental` feature flags                   |
| Document `defineMiddleware` alongside `defineHandler`  | adopted | routing.md: middleware is a distinct concept with different return semantics       |
| Omit renderer/rendu in main SKILL.md                   | adopted | Niche feature; available in vendored docs if needed                                |
| Include Hono as primary framework example              | adopted | Example app uses Hono; hono.md shows the pattern                                   |

## Coverage matrix

| Dimension                                   | Coverage | Evidence                                                                                                                                      |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| API surface and behavior contracts          | complete | api-surface.md covers all core APIs: defineHandler, routing, cache, storage, database, plugins, tasks, WebSocket, config, modules, deployment |
| Configuration/runtime options               | complete | api-surface.md config tables, runtime config section                                                                                          |
| Common downstream use cases                 | complete | common-use-cases.md: 12 use cases covering project setup through deployment                                                                   |
| Known issues/failure modes with workarounds | complete | troubleshooting-workarounds.md: 24 issues covering errors, routing, caching, storage, deployment, and migration                               |
| Version/migration variance                  | complete | troubleshooting-workarounds.md migration section: full v2→v3 API and preset mapping                                                           |

## Open gaps

- Cloudflare Workers deployment details beyond binding access migration (low priority — vendored docs cover this)
- OpenAPI/Swagger experimental feature (incomplete upstream docs)
- Detailed config/index.md options (1,147 lines) not fully inlined — available via vendored docs

## Stopping rationale

All five required integration-documentation dimensions are covered at `complete` status. The vendored Nitro docs (78 files, ~13K lines) have been read and synthesized into the three required reference files. Additional retrieval would yield diminishing returns — the remaining uncovered material (individual deployment providers, rendu renderer details) represents niche features accessible via the vendored `node_modules/nitro/skills/nitro/docs/` when needed.
