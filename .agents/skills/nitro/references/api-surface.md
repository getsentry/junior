# Nitro v3 API Surface

## Contents

- [Configuration](#configuration)
- [Handler definition](#handler-definition)
- [Routing](#routing)
- [Route rules](#route-rules)
- [Server entry](#server-entry)
- [Caching](#caching)
- [Storage](#storage)
- [Database](#database)
- [Plugins and hooks](#plugins-and-hooks)
- [Tasks](#tasks)
- [WebSocket](#websocket)
- [Assets](#assets)
- [Runtime config](#runtime-config)
- [Modules (build-time)](#modules-build-time)
- [Deployment presets](#deployment-presets)

---

## Configuration

### Standalone (`nitro.config.ts`)

```ts
import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  preset: "vercel",
  serverDir: "./server",
  routeRules: { "/api/**": { cache: true } },
});
```

`defineNitroConfig` is also aliased as `defineConfig` from `"nitro"`:

```ts
import { defineConfig } from "nitro";
export default defineConfig({ preset: "node" });
```

### Vite plugin (`vite.config.ts`)

```ts
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [nitro()],
  nitro: {
    serverDir: "./server",
  },
});
```

### Environment-specific config

Uses c12 conventions with `$development` and `$production` keys:

```ts
export default defineNitroConfig({
  $development: { debug: true },
  $production: { minify: true },
});
```

### Key config options

| Option                     | Default       | Description                                                           |
| -------------------------- | ------------- | --------------------------------------------------------------------- |
| `preset`                   | auto-detected | Deployment target (`vercel`, `cloudflare_pages`, `node_server`, etc.) |
| `compatibilityDate`        | `"latest"`    | Locks preset behavior to a date                                       |
| `serverDir`                | `false`       | Server source directory (`"./server"` or `"./"` to enable scanning)   |
| `baseURL`                  | `"/"`         | Server base URL                                                       |
| `apiBaseURL`               | `"/api"`      | API routes prefix                                                     |
| `imports`                  | `false`       | Auto-imports config (set to `{}` to enable)                           |
| `modules`                  | `[]`          | Build-time Nitro modules                                              |
| `plugins`                  | `[]`          | Runtime plugins (auto-scanned from `plugins/`)                        |
| `routes`                   | `{}`          | Programmatic route-to-handler mapping                                 |
| `handlers`                 | `[]`          | Programmatic handler/middleware registration                          |
| `routeRules`               | `{}`          | Pattern-based route rules                                             |
| `runtimeConfig`            | `{}`          | Runtime config (env override via `NITRO_` prefix)                     |
| `storage` / `devStorage`   | `{}`          | Storage driver configuration                                          |
| `database` / `devDatabase` | `{}`          | Database connector configuration                                      |
| `features.websocket`       | `false`       | Enable WebSocket support                                              |
| `experimental.database`    | `false`       | Enable database layer                                                 |
| `experimental.tasks`       | `false`       | Enable tasks                                                          |
| `experimental.openAPI`     | `false`       | Enable OpenAPI endpoints                                              |
| `builder`                  | auto          | `"rollup"` / `"rolldown"` / `"vite"`                                  |
| `minify`                   | `false`       | Minify production bundle                                              |
| `sourcemap`                | `false`       | Source maps                                                           |
| `ignore`                   | `[]`          | Glob patterns to ignore during route scanning                         |

### Directory options

| Option             | Default               | Description          |
| ------------------ | --------------------- | -------------------- |
| `rootDir`          | `.`                   | Project root         |
| `serverDir`        | `false`               | Server source dir    |
| `buildDir`         | `node_modules/.nitro` | Build artifacts      |
| `output.dir`       | `.output`             | Production output    |
| `output.serverDir` | `.output/server`      | Server output        |
| `output.publicDir` | `.output/public`      | Public assets output |

### Environment variables

| Variable                   | Description                |
| -------------------------- | -------------------------- |
| `NITRO_PRESET`             | Override deployment preset |
| `NITRO_COMPATIBILITY_DATE` | Set compatibility date     |
| `NITRO_APP_BASE_URL`       | Override base URL          |

---

## Handler definition

```ts
import { defineHandler } from "nitro";

export default defineHandler((event) => {
  return { hello: "world" };
});
```

The `event` is an [H3Event](https://h3.dev/guide/api/h3event) with web standard properties:

| Property               | Type           | Description                          |
| ---------------------- | -------------- | ------------------------------------ |
| `event.req`            | `Request`      | Web standard Request object          |
| `event.res`            | `ResponseInit` | Response headers/status              |
| `event.url`            | `URL`          | Parsed URL                           |
| `event.path`           | `string`       | URL pathname                         |
| `event.method`         | `string`       | HTTP method                          |
| `event.context`        | `object`       | Shared context (params, custom data) |
| `event.context.params` | `object`       | Route parameters                     |

### Reading request body (web standard)

```ts
const json = await event.req.json();
const text = await event.req.text();
const formData = await event.req.formData();
const stream = event.req.body;
```

### Reading/setting headers (web standard)

```ts
event.req.headers.get("x-foo");
event.res.headers.set("x-foo", "bar");
```

### Errors

```ts
import { HTTPError } from "nitro";
throw new HTTPError({ status: 404, message: "Not found" });
```

### Middleware

```ts
import { defineMiddleware } from "nitro";

export default defineMiddleware((event) => {
  event.context.auth = { user: "admin" };
  // Do NOT return — returning terminates the request
});
```

---

## Routing

### Filesystem routing

Files in `routes/` or `api/` are automatically mapped to URL paths:

```
routes/
  api/
    test.ts          → /api/test
  hello.get.ts       → /hello (GET only)
  hello.post.ts      → /hello (POST only)
  users/[id].ts      → /users/:id
  pages/[...slug].ts → /pages/* (catch-all)
  [...].ts           → /* (default catch-all)
```

### Dynamic parameters

- Single: `[param]` — accessed via `event.context.params.param`
- Multiple: `[param1]/[param2]` — each segment is a separate folder
- Catch-all: `[...param]` — captures remaining path including slashes

### HTTP method suffix

Append `.get.ts`, `.post.ts`, `.put.ts`, `.delete.ts`, `.patch.ts`, etc.

### Route groups

Parenthesized folders `(groupname)/` organize files without affecting URL paths:

```
routes/api/(admin)/users.ts   → /api/users
routes/api/(public)/index.ts  → /api
```

### Environment-specific handlers

`.dev.ts`, `.prod.ts`, `.prerender.ts` suffixes restrict to specific build environments.

### Programmatic routes

```ts
export default defineNitroConfig({
  routes: {
    "/api/hello": "./server/routes/api/hello.ts",
    "/api/custom": {
      handler: "./server/routes/api/hello.ts",
      method: "POST",
      lazy: true,
    },
  },
});
```

Route entry options: `handler`, `method`, `lazy`, `format` (`"web"` | `"node"`), `env`.

### Programmatic handlers (middleware)

```ts
export default defineNitroConfig({
  handlers: [
    {
      route: "/api/**",
      handler: "./server/middleware/api-auth.ts",
      middleware: true,
    },
  ],
});
```

Handler entry options: `route`, `handler`, `method`, `middleware`, `lazy`, `format`, `env`.

### Middleware

Auto-registered from `middleware/` directory. Execution order follows alphabetical sort (prefix with numbers: `01.logger.ts`, `02.auth.ts`).

### Code splitting

Each route handler gets its own chunk, loaded on demand at first request.

---

## Route rules

Pattern-based rules applied via config. Pattern matching follows [rou3](https://github.com/h3js/rou3).

```ts
export default defineNitroConfig({
  routeRules: {
    "/blog/**": { swr: 600 },
    "/assets/**": { headers: { "cache-control": "s-maxage=0" } },
    "/api/v1/**": { cors: true },
    "/old-page": { redirect: "/new-page" },
    "/proxy/**": { proxy: "https://api.example.com/**" },
    "/admin/**": { basicAuth: { username: "admin", password: "secret" } },
  },
});
```

### Available rule options

| Option      | Type                                      | Description                                         |
| ----------- | ----------------------------------------- | --------------------------------------------------- |
| `headers`   | `Record<string, string>`                  | Custom response headers                             |
| `redirect`  | `string \| { to, status? }`               | Redirect (default 307)                              |
| `proxy`     | `string \| { to, ...proxyOptions }`       | Proxy requests                                      |
| `cors`      | `boolean`                                 | Permissive CORS headers                             |
| `cache`     | `object \| false`                         | Cache options                                       |
| `swr`       | `boolean \| number`                       | Shortcut for `cache: { swr: true, maxAge: number }` |
| `static`    | `boolean \| number`                       | Static caching                                      |
| `basicAuth` | `{ username, password, realm? } \| false` | HTTP Basic Auth                                     |
| `prerender` | `boolean`                                 | Prerender at build time                             |
| `isr`       | `boolean \| number \| object`             | ISR (Vercel)                                        |

Rules merge from least to most specific. Use `false` to disable an inherited rule.

### Runtime route rules

Override via `runtimeConfig.nitro.routeRules` and environment variables.

---

## Server entry

`server.ts` is auto-detected in project root and acts as a catch-all handler for unmatched routes.

### Web-compatible framework

```ts
// server.ts — Hono
import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.text("Hello from Hono!"));
export default app;
```

### Node.js framework (server.node.ts)

```ts
// server.node.ts — Express
import Express from "express";
const app = Express();
app.use("/", (_req, res) => res.send("Hello from Express!"));
export default app;
```

### Config options

```ts
export default defineNitroConfig({
  serverEntry: "./custom-server.ts",
  // or object:
  serverEntry: { handler: "./server.ts", format: "node" },
  // or disable:
  serverEntry: false,
});
```

### Lifecycle position

Server entry runs after routes, middleware, and static assets — it catches unmatched requests before the renderer.

---

## Caching

Powered by [ocache](https://github.com/unjs/ocache), built on the storage layer.

### Cached handler

```ts
import { defineCachedHandler } from "nitro/cache";

export default defineCachedHandler(
  (event) => {
    return { data: expensiveComputation() };
  },
  { maxAge: 3600, swr: true },
);
```

### Cached function

```ts
import { defineCachedFunction } from "nitro/cache";

const cachedFetch = defineCachedFunction(
  async (url: string) => {
    return fetch(url).then((r) => r.json());
  },
  { maxAge: 3600, name: "apiFetch", getKey: (url) => url },
);
```

### Cache options (shared)

| Option                  | Default                                   | Description                        |
| ----------------------- | ----------------------------------------- | ---------------------------------- |
| `base`                  | `"cache"`                                 | Storage mount point                |
| `name`                  | guessed                                   | Cache entry name                   |
| `group`                 | `"nitro/handlers"` or `"nitro/functions"` | Cache group                        |
| `getKey`                | built-in hash                             | Custom cache key function          |
| `integrity`             | function code hash                        | Invalidation token                 |
| `maxAge`                | `1`                                       | TTL in seconds                     |
| `staleMaxAge`           | `0`                                       | Max stale age (`-1` for unlimited) |
| `swr`                   | `true`                                    | Stale-while-revalidate             |
| `shouldInvalidateCache` | —                                         | Invalidation predicate             |
| `shouldBypassCache`     | —                                         | Bypass predicate                   |

### Handler-only options

| Option        | Description                                               |
| ------------- | --------------------------------------------------------- |
| `headersOnly` | Skip full caching, only handle conditional requests (304) |
| `varies`      | Header names to vary cache key on                         |

### Function-only options

| Option           | Description                                        |
| ---------------- | -------------------------------------------------- |
| `transformEntry` | Transform cache entry before returning             |
| `validate`       | Validate cache entry, return `false` to re-resolve |

### Automatic HTTP headers

Cached handlers auto-set `etag`, `last-modified`, and `cache-control`. Conditional requests (`if-none-match`, `if-modified-since`) return 304.

### Cache key pattern

```
${base}:${group}:${name}:${getKey(...)}.json
```

### Manual invalidation

```ts
import { useStorage } from "nitro/storage";
await useStorage("cache").removeItem("nitro/functions:name:key.json");
```

### Route rules caching

```ts
routeRules: {
  "/blog/**": { swr: 600 },
  "/api/**": { cache: { maxAge: 60, base: "redis" } },
}
```

---

## Storage

Built on [unstorage](https://unstorage.unjs.io). In-memory by default.

```ts
import { useStorage } from "nitro/storage";

await useStorage().setItem("key", value);
const val = await useStorage().getItem("key");

// Namespaced
const redis = useStorage("redis");
await redis.setItem("foo", "bar");
```

### Methods

| Method                   | Description                 |
| ------------------------ | --------------------------- |
| `getItem(key)`           | Get value (null if missing) |
| `setItem(key, value)`    | Set value                   |
| `hasItem(key)`           | Check existence             |
| `removeItem(key)`        | Delete key                  |
| `getKeys(base?)`         | List keys                   |
| `clear(base?)`           | Clear keys                  |
| `getItemRaw(key)`        | Get raw binary              |
| `setItemRaw(key, value)` | Set raw binary              |
| `getMeta(key)`           | Get metadata                |
| `mount(base, driver)`    | Dynamic mount               |
| `unmount(base)`          | Unmount driver              |
| `watch(callback)`        | Watch changes               |

### Configuration

```ts
export default defineNitroConfig({
  storage: {
    redis: { driver: "redis", url: "redis://localhost:6379" },
  },
  devStorage: {
    redis: { driver: "fs", base: "./.data/redis" },
  },
});
```

### Built-in mount points

- `assets/server` — read-only bundled server assets
- Root (no base) — in-memory, not persisted

### Runtime mounting via plugin

```ts
import { useStorage } from "nitro/storage";
import { definePlugin } from "nitro";
import redisDriver from "unstorage/drivers/redis";

export default definePlugin(() => {
  useStorage().mount("redis", redisDriver({ host: process.env.REDIS_HOST }));
});
```

---

## Database

Experimental. Built on [db0](https://db0.unjs.io). SQLite by default (`.data/db.sqlite`).

```ts
export default defineNitroConfig({
  experimental: { database: true },
  database: {
    default: { connector: "sqlite" },
    users: { connector: "postgresql", options: { url: "..." } },
  },
});
```

### Usage

```ts
import { useDatabase } from "nitro/database";

const db = useDatabase();
const { rows } = await db.sql`SELECT * FROM users WHERE id = ${id}`;
await db.exec("CREATE TABLE ...");
```

### Connectors

`sqlite`, `better-sqlite3`, `postgresql`, `mysql2`, `pglite`, `libsql`, `planetscale`, `cloudflare-d1`, and more.

---

## Plugins and hooks

Plugins execute once at server startup. Auto-registered from `plugins/` directory.

```ts
import { definePlugin } from "nitro";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("request", (event) => {
    /* ... */
  });
  nitroApp.hooks.hook("response", (res, event) => {
    /* ... */
  });
  nitroApp.hooks.hook("error", (error, { event, tags }) => {
    /* ... */
  });
  nitroApp.hooks.hook("close", () => {
    /* cleanup */
  });
});
```

### `nitroApp` context

| Property       | Type                       | Description          |
| -------------- | -------------------------- | -------------------- |
| `hooks`        | `HookableCore`             | Hook system          |
| `h3`           | `H3Core`                   | Underlying H3 app    |
| `fetch`        | `(req) => Response`        | Internal fetch       |
| `captureError` | `(error, context) => void` | Manual error capture |

### Runtime hooks

| Hook       | Signature                            | When                   |
| ---------- | ------------------------------------ | ---------------------- |
| `request`  | `(event) => void`                    | Start of each request  |
| `response` | `(res, event) => void`               | After response created |
| `error`    | `(error, { event?, tags? }) => void` | On error capture       |
| `close`    | `() => void`                         | Server shutdown        |

Error tags: `"request"`, `"response"`, `"cache"`, `"plugin"`, `"unhandledRejection"`, `"uncaughtException"`.

---

## Tasks

Experimental. File-based in `tasks/` directory.

```ts
import { defineTask } from "nitro/task";

export default defineTask({
  meta: { name: "db:migrate", description: "Run migrations" },
  run({ payload, context }) {
    return { result: "done" };
  },
});
```

### Scheduled tasks

```ts
export default defineNitroConfig({
  experimental: { tasks: true },
  scheduledTasks: {
    "0 * * * *": ["cms:update"],
    "0 0 * * *": ["db:cleanup"],
  },
});
```

On Vercel, scheduled tasks auto-convert to Vercel Cron Jobs. Secure with `CRON_SECRET` env var.

---

## WebSocket

Enable with `features: { websocket: true }`.

```ts
import { defineWebSocketHandler } from "nitro";

export default defineWebSocketHandler({
  open(peer) {
    peer.send("Welcome!");
    peer.subscribe("chat");
  },
  message(peer, message) {
    peer.publish("chat", message.toString());
  },
  close(peer) {
    /* ... */
  },
});
```

Route convention: `routes/_ws.ts`. Built on [crossws](https://crossws.h3.dev).

Peer API: `peer.send()`, `peer.publish(channel, msg)`, `peer.subscribe(channel)`.

---

## Assets

### Public assets

Files in `public/` are served statically. Config via `publicAssets` array. Supports pre-compression (gzip, brotli, zstd).

### Server assets

Files in `assets/` are bundled and accessible via `useStorage("assets/server")`.

```ts
const content = await useStorage("assets/server").getItem("data.json");
```

Custom asset dirs via `serverAssets` config with `baseName` and `dir`.

---

## Runtime config

Define defaults in config, override with `NITRO_`-prefixed env vars at runtime:

```ts
export default defineNitroConfig({
  runtimeConfig: { apiKey: "", database: { host: "localhost" } },
});
```

```ts
import { useRuntimeConfig } from "nitro/runtime-config";

const config = useRuntimeConfig();
// config.apiKey — overridden by NITRO_API_KEY
// config.database.host — overridden by NITRO_DATABASE_HOST
```

Only keys defined in `runtimeConfig` are considered. `.env` files only loaded in development.

Custom prefix: set `runtimeConfig.nitro.envPrefix: "APP_"` to also check `APP_*` vars.

---

## Modules (build-time)

Build-time extension mechanism:

```ts
interface NitroModule {
  name?: string;
  setup: (nitro: Nitro) => void | Promise<void>;
}
```

Registered via `modules` config or as Vite plugins with a `nitro` property:

```ts
export default defineConfig({
  plugins: [
    nitro(),
    {
      name: "my-plugin",
      nitro: {
        setup(nitro) {
          nitro.options.routes["/"] = "#virtual";
          nitro.options.virtual["#virtual"] =
            `export default () => new Response("Hi")`;
        },
      },
    },
  ],
});
```

---

## Deployment presets

### Zero-config auto-detection

Vercel, Netlify, Cloudflare, AWS Amplify, Azure, Firebase App Hosting, StormKit, Zeabur.

### Manual preset

```ts
export default defineNitroConfig({ preset: "cloudflare_pages" });
```

Or via env: `NITRO_PRESET=cloudflare_pages nitro build`.

### Vercel-specific

- `/api` directory incompatible — use `routes/api/` instead
- Proxy route rules auto-optimized to CDN rewrites
- `scheduledTasks` auto-converted to Vercel Cron Jobs
- ISR via `isr` route rule with `expiration`, `group`, `allowQuery`, `passQuery`
- On-demand ISR revalidation via `x-prerender-revalidate` header with `bypassToken`
- Bun runtime via `vercel.functions.runtime: "bun1.x"`
- Custom build output via `vercel.config`

### Node.js server

Default production preset. Output: `.output/server/index.mjs`.

Env vars: `NITRO_PORT` (default 3000), `NITRO_HOST`, `NITRO_UNIX_SOCKET`, `NITRO_SSL_CERT`/`NITRO_SSL_KEY`.

Cluster mode preset: `node_cluster` with `NITRO_CLUSTER_WORKERS`.
