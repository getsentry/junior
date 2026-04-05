# Common Use Cases

## Contents

- [1. Create a new Nitro project](#1-create-a-new-nitro-project)
- [2. Add a web framework as server entry](#2-add-a-web-framework-as-server-entry)
- [3. Build a REST API with filesystem routing](#3-build-a-rest-api-with-filesystem-routing)
- [4. Cache expensive endpoints](#4-cache-expensive-endpoints)
- [5. Add KV storage with Redis](#5-add-kv-storage-with-redis)
- [6. Create runtime plugins for cross-cutting concerns](#6-create-runtime-plugins-for-cross-cutting-concerns)
- [7. Add WebSocket support](#7-add-websocket-support)
- [8. Configure runtime environment variables](#8-configure-runtime-environment-variables)
- [9. Deploy to Vercel with ISR](#9-deploy-to-vercel-with-isr)
- [10. Use the database layer](#10-use-the-database-layer)
- [11. Schedule background tasks](#11-schedule-background-tasks)
- [12. Add middleware for authentication](#12-add-middleware-for-authentication)

---

## 1. Create a new Nitro project

### Standalone

```json
// package.json
{
  "type": "module",
  "scripts": {
    "dev": "nitro dev",
    "build": "nitro build",
    "preview": "node .output/server/index.mjs"
  },
  "devDependencies": { "nitro": "latest" }
}
```

```ts
// nitro.config.ts
import { defineConfig } from "nitro";
export default defineConfig({});
```

```ts
// server.ts
export default {
  fetch(req: Request) {
    return new Response("Hello Nitro!");
  },
};
```

```json
// tsconfig.json
{ "extends": "nitro/tsconfig" }
```

### With Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";
export default defineConfig({ plugins: [nitro()] });
```

Options go under the `nitro` key in `vite.config.ts` instead of a separate `nitro.config.ts`.

---

## 2. Add a web framework as server entry

Nitro auto-detects `server.ts` in the project root. Export any object with a `fetch(Request): Response` method.

### Hono

```ts
// server.ts
import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.text("Hello from Hono!"));
export default app;
```

### Elysia

```ts
// server.ts
import { Elysia } from "elysia";
const app = new Elysia();
app.get("/", () => "Hello from Elysia!");
export default app.compile();
```

### Express (Node.js — use `server.node.ts`)

```ts
// server.node.ts
import Express from "express";
const app = Express();
app.use("/", (_req, res) => res.send("Hello from Express!"));
export default app;
```

The `.node.ts` suffix tells Nitro to convert the Node.js handler to a web-compatible one.

### Fastify (Node.js — use `server.node.ts`)

```ts
// server.node.ts
import Fastify from "fastify";
const app = Fastify();
app.get("/", () => "Hello from Fastify!");
await app.ready();
export default app.routing;
```

---

## 3. Build a REST API with filesystem routing

```
routes/
  api/
    users/
      index.ts          → GET /api/users (list)
      index.post.ts     → POST /api/users (create)
      [id].get.ts       → GET /api/users/:id (read)
      [id].put.ts       → PUT /api/users/:id (update)
      [id].delete.ts    → DELETE /api/users/:id (delete)
```

```ts
// routes/api/users/index.ts
import { defineHandler } from "nitro";

export default defineHandler(() => {
  return [{ id: "1", name: "Alice" }];
});
```

```ts
// routes/api/users/index.post.ts
import { defineHandler } from "nitro";

export default defineHandler(async (event) => {
  const body = await event.req.json();
  return { created: true, user: body };
});
```

```ts
// routes/api/users/[id].get.ts
import { defineHandler } from "nitro";

export default defineHandler((event) => {
  return { id: event.context.params.id, name: "Alice" };
});
```

Enable scanning with `serverDir`:

```ts
// nitro.config.ts
import { defineConfig } from "nitro";
export default defineConfig({ serverDir: "./" });
```

---

## 4. Cache expensive endpoints

### Cache entire route response

```ts
// routes/api/stats.ts
import { defineCachedHandler } from "nitro/cache";

export default defineCachedHandler(
  async () => {
    const data = await fetch("https://api.example.com/stats").then((r) =>
      r.json(),
    );
    return data;
  },
  { maxAge: 3600 }, // 1 hour
);
```

### Cache a reusable function

```ts
import { defineCachedFunction } from "nitro/cache";
import { defineHandler } from "nitro";

const cachedGHStars = defineCachedFunction(
  async (repo: string) => {
    const data = await fetch(`https://api.github.com/repos/${repo}`).then((r) =>
      r.json(),
    );
    return data.stargazers_count;
  },
  { maxAge: 3600, name: "ghStars", getKey: (repo) => repo },
);

export default defineHandler(async (event) => {
  const stars = await cachedGHStars(event.context.params.repo);
  return { stars };
});
```

### Cache via route rules (no code changes)

```ts
// nitro.config.ts
export default defineNitroConfig({
  routeRules: {
    "/api/stats/**": { swr: 600 },
    "/api/realtime/**": { cache: false },
  },
});
```

### Bypass cache conditionally

```ts
defineCachedHandler(handler, {
  shouldBypassCache: ({ req }) => req.url.includes("skipCache=true"),
});
```

---

## 5. Add KV storage with Redis

```ts
// nitro.config.ts
import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  storage: {
    redis: { driver: "redis", url: "redis://localhost:6379" },
  },
  devStorage: {
    redis: { driver: "fs", base: "./.data/redis" },
  },
});
```

```ts
// routes/api/counter.ts
import { defineHandler } from "nitro";
import { useStorage } from "nitro/storage";

export default defineHandler(async () => {
  const storage = useStorage("redis");
  const count = ((await storage.getItem<number>("count")) ?? 0) + 1;
  await storage.setItem("count", count);
  return { count };
});
```

### Dynamic mounting in a plugin

```ts
// plugins/storage.ts
import { definePlugin } from "nitro";
import { useStorage } from "nitro/storage";
import redisDriver from "unstorage/drivers/redis";

export default definePlugin(() => {
  useStorage().mount(
    "redis",
    redisDriver({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    }),
  );
});
```

---

## 6. Create runtime plugins for cross-cutting concerns

### Request logging

```ts
// plugins/logger.ts
import { definePlugin } from "nitro";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("request", (event) => {
    console.log(`[${event.method}] ${event.path}`);
  });
});
```

### Error reporting

```ts
// plugins/errors.ts
import { definePlugin } from "nitro";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("error", (error, { event, tags }) => {
    console.error(`Error [${tags?.join(",")}] on ${event?.path}:`, error);
    // Send to error tracking service
  });
});
```

### Security headers

```ts
// plugins/security.ts
import { definePlugin } from "nitro";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("response", (res) => {
    res.headers.set("x-content-type-options", "nosniff");
    res.headers.set("x-frame-options", "DENY");
  });
});
```

### Graceful shutdown

```ts
// plugins/cleanup.ts
import { definePlugin } from "nitro";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("close", async () => {
    await closeDatabaseConnections();
  });
});
```

---

## 7. Add WebSocket support

```ts
// nitro.config.ts
import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./",
  features: { websocket: true },
});
```

```ts
// routes/_ws.ts
import { defineWebSocketHandler } from "nitro";

export default defineWebSocketHandler({
  open(peer) {
    peer.send("Welcome!");
    peer.subscribe("chat");
  },
  message(peer, message) {
    const msg = message.toString();
    if (msg === "ping") {
      peer.send("pong");
    } else {
      peer.publish("chat", msg);
    }
  },
  close(peer) {
    peer.publish("chat", `${peer} disconnected`);
  },
});
```

Client connects to `ws://localhost:3000/_ws`.

---

## 8. Configure runtime environment variables

```ts
// nitro.config.ts
export default defineNitroConfig({
  runtimeConfig: {
    apiKey: "",
    database: { host: "localhost", port: 5432 },
  },
});
```

```ts
// routes/api/config.ts
import { defineHandler } from "nitro";
import { useRuntimeConfig } from "nitro/runtime-config";

export default defineHandler(() => {
  const config = useRuntimeConfig();
  return { host: config.database.host };
});
```

Override in production via env vars:

```bash
NITRO_API_KEY=secret
NITRO_DATABASE_HOST=db.example.com
NITRO_DATABASE_PORT=5433
```

Custom prefix:

```ts
runtimeConfig: {
  nitro: { envPrefix: "APP_" },
  apiKey: "",
}
// Now both NITRO_API_KEY and APP_API_KEY work
```

---

## 9. Deploy to Vercel with ISR

```ts
// nitro.config.ts
export default defineNitroConfig({
  preset: "vercel",
  routeRules: {
    "/products/**": {
      isr: {
        expiration: 60,
        allowQuery: ["q"],
        passQuery: true,
      },
    },
    "/api/**": { proxy: "https://api.example.com/**" }, // CDN-level rewrite
  },
});
```

On-demand revalidation:

```ts
export default defineNitroConfig({
  vercel: {
    config: { bypassToken: process.env.VERCEL_BYPASS_TOKEN },
  },
});
```

Trigger revalidation with `x-prerender-revalidate: <bypassToken>` header.

---

## 10. Use the database layer

```ts
// nitro.config.ts
export default defineNitroConfig({
  experimental: { database: true },
  database: {
    default: { connector: "sqlite" },
  },
  devDatabase: {
    default: { connector: "sqlite", options: { name: "dev-db" } },
  },
});
```

```ts
// routes/api/users.ts
import { defineHandler } from "nitro";
import { useDatabase } from "nitro/database";

export default defineHandler(async () => {
  const db = useDatabase();
  const { rows } = await db.sql`SELECT * FROM users`;
  return { users: rows };
});
```

```ts
// tasks/db/migrate.ts
import { defineTask } from "nitro/task";
import { useDatabase } from "nitro/database";

export default defineTask({
  meta: { description: "Run database migrations" },
  async run() {
    const db = useDatabase();
    await db.sql`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT)`;
    return { result: "Migrations complete" };
  },
});
```

---

## 11. Schedule background tasks

```ts
// nitro.config.ts
export default defineNitroConfig({
  experimental: { tasks: true },
  scheduledTasks: {
    "0 * * * *": ["cache:warm"],
    "0 0 * * *": ["db:cleanup"],
  },
});
```

```ts
// tasks/cache/warm.ts
import { defineTask } from "nitro/task";

export default defineTask({
  meta: { name: "cache:warm", description: "Warm API caches" },
  async run() {
    await fetch("http://localhost:3000/api/stats");
    return { result: "Cache warmed" };
  },
});
```

On Vercel, set `CRON_SECRET` env var to secure cron endpoints.

---

## 12. Add middleware for authentication

### Global middleware (all routes)

```ts
// middleware/01.auth.ts
import { defineMiddleware } from "nitro";

export default defineMiddleware((event) => {
  const token = event.req.headers.get("authorization");
  if (event.path.startsWith("/api/protected") && !token) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (token) {
    event.context.user = { token };
  }
});
```

### Route-scoped middleware (config-based)

```ts
// nitro.config.ts
export default defineNitroConfig({
  handlers: [
    {
      route: "/api/admin/**",
      handler: "./server/middleware/admin-auth.ts",
      middleware: true,
    },
  ],
});
```

### Basic auth via route rules (no code)

```ts
export default defineNitroConfig({
  routeRules: {
    "/admin/**": {
      basicAuth: { username: "admin", password: "secret", realm: "Admin" },
    },
    "/admin/public/**": { basicAuth: false },
  },
});
```
