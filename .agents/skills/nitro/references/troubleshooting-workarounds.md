# Troubleshooting & Workarounds

## Contents

- [Common errors](#common-errors)
- [Routing issues](#routing-issues)
- [Caching issues](#caching-issues)
- [Storage issues](#storage-issues)
- [Deployment issues](#deployment-issues)
- [Migration from v2](#migration-from-v2)
- [Diagnostic checklist](#diagnostic-checklist)

---

## Common errors

### 1. `Cannot find module 'nitropack'`

**Cause:** Using the v2 package name. Nitro v3 renamed `nitropack` to `nitro`.

**Fix:** Update `package.json` and all imports:

```diff
- "nitropack": "latest"
+ "nitro": "latest"
```

```diff
- import { defineNitroConfig } from "nitropack/config"
+ import { defineNitroConfig } from "nitro/config"
```

### 2. `defineEventHandler is not a function` / `defineEventHandler is not defined`

**Cause:** Using the v2 handler API. Nitro v3 uses `defineHandler`.

**Fix:**

```diff
- import { defineEventHandler } from "nitropack/runtime"
+ import { defineHandler } from "nitro"
```

### 3. `readBody is not a function`

**Cause:** Using v2 body utilities. Nitro v3 / H3 v2 uses web standard Request methods.

**Fix:**

```diff
- const body = await readBody(event);
+ const body = await event.req.json();
```

Other replacements:

- `readRawBody(event)` → `event.req.text()` or `event.req.body` (stream)
- `readFormData(event)` → `event.req.formData()`

### 4. `getHeader is not a function` / `setHeader is not a function`

**Cause:** Using v2 header utilities. H3 v2 uses web standard Headers API.

**Fix:**

```diff
- getHeader(event, "x-foo")
+ event.req.headers.get("x-foo")

- setHeader(event, "x-foo", "bar")
+ event.res.headers.set("x-foo", "bar")
```

### 5. `createError is not a function`

**Cause:** Using v2 error utility. Nitro v3 uses `HTTPError`.

**Fix:**

```diff
- import { createError } from "nitro/h3"
- throw createError({ statusCode: 404, statusMessage: "Not found" })
+ import { HTTPError } from "nitro"
+ throw new HTTPError({ status: 404, message: "Not found" })
```

### 6. `useAppConfig is not a function`

**Cause:** App config was removed in Nitro v3.

**Fix:** Use a regular `.ts` file in your server directory and import it directly, or use `runtimeConfig`.

### 7. `useNitroApp().hooks is undefined`

**Cause:** `useNitroApp().hooks` may be undefined outside of plugins in v3.

**Fix:** Use `useNitroHooks()` instead:

```diff
- useNitroApp().hooks.hook("request", handler)
+ import { useNitroHooks } from "nitro/app"
+ useNitroHooks().hook("request", handler)
```

### 8. `Type 'X' is not exported from 'nitro'`

**Cause:** Nitro v3 exports types only from `nitro/types`.

**Fix:**

```diff
- import type { NitroRuntimeConfig } from "nitro"
+ import type { NitroRuntimeConfig } from "nitro/types"
```

---

## Routing issues

### 9. Route returns 404

**Possible causes and fixes:**

1. **File not in scanned directory:** Routes must be in `routes/`, `api/`, or the directory set by `serverDir`. Verify file location.
2. **`serverDir` not enabled:** If using `routes/` under a `server/` directory, set `serverDir: "./server"` or `serverDir: "./"`.
3. **Programmatic route not registered:** Check `routes` or `handlers` config for typos in pattern or handler path.
4. **Route file ignored:** Check `ignore` config for patterns that might exclude the file.

### 10. Middleware runs on unwanted routes

**Cause:** Global middleware in `middleware/` runs on all routes.

**Fix:** Either:

- Add path checks inside the middleware: `if (!event.path.startsWith("/api")) return;`
- Use route-scoped middleware via `handlers` config with `middleware: true` and a specific `route` pattern.

### 11. Middleware response terminates request unexpectedly

**Cause:** Middleware returns a value, which closes the request pipeline.

**Fix:** Do not return from middleware unless intentionally terminating. Set context instead:

```diff
- return { user: "admin" };
+ event.context.user = "admin";
```

### 12. `/api` directory not working on Vercel

**Cause:** Nitro's `/api` directory conflicts with Vercel's built-in `/api` directory.

**Fix:** Use `routes/api/` instead of a top-level `api/` directory.

---

## Caching issues

### 13. POST/PUT/DELETE requests not cached

**Cause:** `defineCachedHandler` only caches `GET` and `HEAD` requests. Other methods bypass automatically.

**Fix:** This is by design. If you need to cache results of non-GET operations, use `defineCachedFunction` on the underlying logic.

### 14. Cached response ignores request headers

**Cause:** Request headers are dropped by default in cached responses.

**Fix:** Use the `varies` option to include specific headers in the cache key:

```ts
defineCachedHandler(handler, {
  varies: ["host", "x-forwarded-host", "authorization"],
});
```

### 15. Cache not invalidating

**Cause:** Cache entries persist until `maxAge` expires or manual invalidation.

**Fix:** Manual invalidation:

```ts
import { useStorage } from "nitro/storage";
await useStorage("cache").removeItem("nitro/handlers:routeName:keyHash.json");
```

Or use `shouldInvalidateCache` option for conditional invalidation.

### 16. Stale cache served indefinitely

**Cause:** With `swr: true` (default), stale values are served while revalidating in background.

**Fix:** Set `swr: false` to wait for fresh values, or set `staleMaxAge` to limit stale duration:

```ts
defineCachedHandler(handler, {
  maxAge: 3600,
  swr: true,
  staleMaxAge: 600, // Serve stale for max 10 minutes
});
```

---

## Storage issues

### 17. Storage data lost on restart

**Cause:** Default storage uses in-memory driver, which does not persist.

**Fix:** Mount a persistent driver:

```ts
storage: {
  data: { driver: "fs", base: "./.data" },
}
```

### 18. Storage driver not available in development

**Cause:** Production driver (e.g., managed Redis) not accessible locally.

**Fix:** Use `devStorage` to override with a local driver:

```ts
devStorage: {
  redis: { driver: "fs", base: "./.data/redis" },
}
```

---

## Deployment issues

### 19. Vercel function timeout (504)

**Cause:** Function exceeds `maxDuration` limit.

**Fix:** Increase `maxDuration` in Vercel config:

```ts
export default defineNitroConfig({
  vercel: {
    functions: { maxDuration: 300 },
  },
});
```

### 20. Preset not auto-detected

**Cause:** CI environment variables not available, or Turborepo strict mode interfering.

**Fix:** Set preset explicitly:

```ts
export default defineNitroConfig({ preset: "vercel" });
```

Or via env: `NITRO_PRESET=vercel`.

### 21. Build output missing files

**Cause:** Files not traced by the bundler (dynamic imports, non-JS assets).

**Fix:** Check `.output/server/` for expected files. For untraceable files, verify they are either:

- Included in `serverAssets` config
- Referenced by static imports
- Copied via a custom Nitro module hook

### 22. Vercel proxy rules invoking serverless function

**Cause:** Proxy rule uses advanced `ProxyOptions` (`headers`, `forwardHeaders`, `cookieDomainRewrite`, etc.).

**Fix:** Remove advanced options to use CDN-level rewrites. Only simple `proxy: "https://..."` rules are offloaded to CDN.

### 23. Scheduled tasks not running on Vercel

**Cause:** `CRON_SECRET` not set, or cron configuration not generated.

**Fix:**

1. Ensure `experimental.tasks: true` is set.
2. Set `CRON_SECRET` env var in Vercel project settings.
3. Verify cron config in `.vercel/output/config.json` after build.

### 24. Cloudflare bindings not accessible

**Cause:** Nitro v3 changed the access path for Cloudflare bindings.

**Fix:**

```diff
- const binding = event.context.cloudflare.env.MY_BINDING
+ const { env } = event.req.runtime.cloudflare
+ const binding = env.MY_BINDING
```

---

## Migration from v2

### Quick reference

| v2                                           | v3                                            |
| -------------------------------------------- | --------------------------------------------- |
| `"nitropack"`                                | `"nitro"`                                     |
| `import { ... } from "nitropack/runtime/*"`  | `import { ... } from "nitro/*"`               |
| `defineEventHandler` / `eventHandler`        | `defineHandler` from `"nitro"`                |
| `readBody(event)`                            | `event.req.json()`                            |
| `getHeader(event, name)`                     | `event.req.headers.get(name)`                 |
| `setHeader(event, name, val)`                | `event.res.headers.set(name, val)`            |
| `createError({ statusCode, statusMessage })` | `new HTTPError({ status, message })`          |
| `event.node.req` / `event.node.res`          | `event.req` (web Request)                     |
| `event.web`                                  | `event.req`                                   |
| `sendRedirect(event, url)`                   | `return redirect(event, url)`                 |
| `send(event, value)`                         | `return value`                                |
| `useAppConfig()`                             | removed — use runtimeConfig or direct imports |
| Types from `"nitropack"`                     | Types from `"nitro/types"`                    |
| `useNitroApp().hooks`                        | `useNitroHooks()` from `"nitro/app"`          |
| `defineNodeListener`                         | `defineNodeHandler` from `"nitro/h3"`         |
| `fromNodeMiddleware`                         | `fromNodeHandler` from `"nitro/h3"`           |
| `toNodeListener`                             | `toNodeHandler` from `"nitro/h3"`             |

### Preset renames

| v2 Preset                          | v3 Preset                   |
| ---------------------------------- | --------------------------- |
| `node`                             | `node_middleware`           |
| `cloudflare` / `cloudflare_worker` | `cloudflare_module`         |
| `vercel-edge`                      | `vercel` (fluid compute)    |
| `azure` / `azure_functions`        | `azure_swa`                 |
| `firebase`                         | `firebase_app_hosting`      |
| `deno`                             | `deno_deploy`               |
| `netlify-builder`                  | `netlify` or `netlify_edge` |
| `iis`                              | `iis_handler`               |
| `edgio`                            | discontinued                |
| `cli`                              | removed                     |
| `service_worker`                   | removed                     |

### Minimum Node.js version

Nitro v3 requires Node.js 20+.

---

## Diagnostic checklist

1. **Check Nitro version:** Confirm `"nitro"` (not `"nitropack"`) in `package.json`.
2. **Check imports:** All runtime utilities use `nitro/*` subpath exports.
3. **Check handler API:** `defineHandler` from `"nitro"`, not `defineEventHandler`.
4. **Check body/header API:** Web standard `event.req.*` methods, not H3 v1 utilities.
5. **Check dev server:** Run `nitro dev` and verify routes at `http://localhost:3000`.
6. **Check build output:** Run `nitro build` and inspect `.output/server/`.
7. **Check preset:** Verify with `NITRO_PRESET` env var or `preset` config option.
8. **Check route scanning:** Verify `serverDir` is set if routes are in a subdirectory.
9. **Check feature flags:** `experimental.database`, `experimental.tasks` enabled if used.
10. **Check storage drivers:** Verify `storage`/`devStorage` config matches runtime environment.
