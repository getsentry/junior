import {
  defineJuniorPlugin,
  type PluginStartedTaskContext,
} from "@sentry/junior-plugin-api";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { createApp, defineJuniorPlugins } from "@/app";
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE } from "@/deployment";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import { mswServer } from "../msw/server";

// Chat config reads the queue API URL when it loads, so pick the port first.
const { port, previousEnv } = await vi.hoisted(async () => {
  const { createServer: createPortProbe } = await import("node:net");
  const probe = createPortProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("No free port for the local queue server");
  }
  const previousEnv = {
    JUNIOR_QUEUE_API_URL: process.env["JUNIOR_QUEUE_API_URL"],
  };
  process.env["JUNIOR_QUEUE_API_URL"] = `http://127.0.0.1:${address.port}`;
  return { port: address.port, previousEnv };
});

afterAll(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

let server: LocalVercelQueueServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A provider store that a test can make fail a number of times. */
function createDemoStore() {
  return {
    applied: [] as string[],
    failuresLeft: 0,
    writes: 0,
    async write(value: string): Promise<void> {
      this.writes += 1;
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        throw new Error("The demo store is down");
      }
      this.applied.push(value);
    },
  };
}

type DemoStore = ReturnType<typeof createDemoStore>;

/** A plugin whose webhook writes inline and starts a task when that fails. */
function demoPlugin(store: DemoStore) {
  return defineJuniorPlugin({
    manifest: { name: "demo", displayName: "Demo", description: "Demo" },
    tasks: {
      applyWrite: {
        payload: z.object({ value: z.string() }).strict(),
        async run(ctx: PluginStartedTaskContext<{ value: string }>) {
          await store.write(ctx.payload.value);
        },
      },
    },
    hooks: {
      routes(ctx) {
        return [
          {
            method: "POST",
            path: "/api/webhooks/demo",
            async handler(request) {
              const { key, value } = z
                .object({ key: z.string(), value: z.string() })
                .parse(await request.json());
              try {
                await store.write(value);
              } catch {
                await ctx.tasks.start({
                  key,
                  name: "applyWrite",
                  payload: { value },
                });
              }
              return new Response("Accepted", { status: 202 });
            },
          },
        ];
      },
    },
  });
}

async function deliverWebhook(
  app: Awaited<ReturnType<typeof createApp>>,
  body: { key: string; value: string },
): Promise<void> {
  const response = await app.request("/api/webhooks/demo", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(202);
}

async function waitFor(check: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the plugin task");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("plugin tasks that a route starts", () => {
  /** Start the app with the local Vercel Queues server pushing to its task route. */
  async function startQueuedApp(store: DemoStore) {
    await disconnectStateAdapter();
    const app = await createApp({
      conversationWorkQueue: () => createConversationWorkQueueTestAdapter(),
      plugins: defineJuniorPlugins([demoPlugin(store)]),
      waitUntil: createWaitUntilCollector().fn,
    });
    const url = `http://app.localhost${JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE}`;
    server = await startLocalVercelQueueServer({
      consumers: [
        { consumerGroup: "plugin-tasks", topic: "junior_plugin_tasks", url },
      ],
      fetch: async (request) =>
        request.url === url
          ? await app.fetch(request)
          : new Response(null, { status: 404 }),
      // The SDK leases each message for at least 30 seconds. A short lease
      // keeps the backoff of each retry short in this test.
      maxLeaseSeconds: 1,
      port,
    });
    return app;
  }

  /** Record the retry delay that the queue SDK asks for after each failure. */
  function recordRetryDelays(): number[] {
    const delays: number[] = [];
    mswServer.events.on("request:start", async ({ request }) => {
      // The SDK changes the lease of the failed message to the delay.
      if (request.method !== "PATCH" || !request.url.includes("/lease/")) {
        return;
      }
      const body = z
        .object({ visibilityTimeoutSeconds: z.number() })
        .parse(await request.clone().json());
      delays.push(body.visibilityTimeoutSeconds);
    });
    return delays;
  }

  afterEach(() => {
    mswServer.events.removeAllListeners();
  });

  it("retries a failed inline write with backoff and applies it once", async () => {
    const store = createDemoStore();
    const app = await startQueuedApp(store);
    const delays = recordRetryDelays();
    // Longer than the 256 characters that Vercel Queues accepts as an
    // idempotency key.
    const key = `change-1:${"x".repeat(300)}`;

    // Injected fault: the provider store fails the inline write and the
    // first two task attempts.
    store.failuresLeft = 3;
    await deliverWebhook(app, { key, value: "merged" });
    await waitFor(() => store.applied.length > 0);

    expect(store.applied).toEqual(["merged"]);
    expect(store.writes).toBe(4);
    expect(delays).toEqual([30, 60]);

    // A second start for the key does nothing while the queue keeps the
    // first message.
    store.failuresLeft = 1;
    await deliverWebhook(app, { key, value: "merged" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(store.applied).toEqual(["merged"]);
    expect(store.writes).toBe(5);
  }, 30_000);

  it("acknowledges the task after its fifth failed delivery", async () => {
    const store = createDemoStore();
    const app = await startQueuedApp(store);
    const delays = recordRetryDelays();

    // Injected fault: the provider store stays down.
    store.failuresLeft = Number.POSITIVE_INFINITY;
    await deliverWebhook(app, { key: "change-2", value: "closed" });
    // One inline write, then five task deliveries.
    await waitFor(() => store.writes === 6);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(store.writes).toBe(6);
    expect(store.applied).toEqual([]);
    expect(delays).toEqual([30, 60, 120, 240]);
  }, 30_000);
});
