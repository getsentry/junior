---
name: nitro
description: Build and deploy universal JavaScript servers with Nitro v3. Use when working with nitro.config.ts, defineNitroConfig, defineHandler, defineConfig, server.ts entry, filesystem routing, route rules, useStorage, defineCachedHandler, useDatabase, definePlugin, runtime hooks, Vercel/Cloudflare deployment, or migrating from Nitro v2/nitropack.
---

Build, configure, and deploy Nitro v3 applications using correct APIs and patterns.

## Step 1: Classify the request

| Request type                                                           | Read first                                  |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| API surface, handler signatures, imports, config options               | `references/api-surface.md`                 |
| Setup, routing, caching, storage, plugins, frameworks, common patterns | `references/common-use-cases.md`            |
| Build failures, runtime errors, deployment issues, migration from v2   | `references/troubleshooting-workarounds.md` |

Load only the reference(s) matching the request. If the task spans categories, load relevant files.

## Step 2: Apply core guardrails

1. Import `defineHandler` from `"nitro"`, not `defineEventHandler` (v2 API).
2. Import config helpers from subpaths: `"nitro/config"`, `"nitro/cache"`, `"nitro/storage"`, `"nitro/database"`, `"nitro/runtime-config"`, `"nitro/types"`.
3. Use web standard `event.req` (Request) for body/headers — not v2 utilities like `readBody` or `getHeader`.
4. Never return from middleware unless intentionally terminating the request.
5. Only `GET`/`HEAD` requests are cached by `defineCachedHandler`; other methods bypass automatically.
6. `useDatabase` and `defineTask` require experimental feature flags.
7. Use `"nitro"` package name, not `"nitropack"` (v2).

## Step 3: Implement

1. For new projects, use `defineConfig` from `"nitro"` in `nitro.config.ts` or add `nitro()` plugin from `"nitro/vite"` to `vite.config.ts`.
2. For server entry, export a web-compatible `fetch(Request): Response` handler from `server.ts`, or use `server.node.ts` for Express/Fastify.
3. For filesystem routes, place handlers in `routes/` or `api/` with `[param]` for dynamic segments and `.get.ts`/`.post.ts` for method-specific routes.
4. For caching, use `defineCachedHandler` from `"nitro/cache"` with `maxAge` and `swr` options.
5. For storage, use `useStorage(namespace)` from `"nitro/storage"` and configure drivers via `storage` config.
6. For plugins, create files in `plugins/` directory using `definePlugin` and hook into `request`, `response`, `error`, or `close`.
7. For deployment, set `preset` in config or use `NITRO_PRESET` env var; Vercel/Netlify/Cloudflare are auto-detected.

## Step 4: Validate

1. Run `nitro dev` and verify routes respond correctly.
2. Run `nitro build` and check `.output/server/` contains expected files.
3. For cached routes, verify cache headers (`etag`, `cache-control`) and 304 responses.
4. For storage, verify data persists across requests with configured driver.
5. For deployment, verify the preset produces correct output format.

## Step 5: Troubleshoot

1. `defineEventHandler is not defined` → use `defineHandler` from `"nitro"` (v3 API).
2. `Cannot find module 'nitropack'` → rename to `"nitro"` in imports and package.json.
3. Route not matched → check file is in `routes/` or `api/`, or verify `routes` config mapping.
4. Middleware returning responses unexpectedly → ensure middleware does not return a value.
5. For detailed diagnostics, read `references/troubleshooting-workarounds.md`.
