import { randomUUID } from "node:crypto";
import {
  defineJuniorPlugin,
  type PluginJobContext,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { QueueWorker } from "@/chat/queue/provider";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";

// Chat config reads the queue provider when it loads, so set it first. CI
// runs Redis at REDIS_URL. Locally, compose.yaml runs it on port 6382.
vi.hoisted(() => {
  process.env.JUNIOR_QUEUE_PROVIDER = "bullmq";
  process.env.JUNIOR_QUEUE_REDIS_URL =
    process.env.REDIS_URL?.trim() || "redis://localhost:6382";
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_SECRET = "plugin-jobs-test-secret";
});

let fixture: LocalJuniorSqlFixture;
let worker: QueueWorker | undefined;
let runs: unknown[];
let watched: boolean[];
let currentRepo: string;
let jobs: PluginJobContext["jobs"] | undefined;

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the plugin job");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A plugin whose webhook route schedules a job that repeats once. */
const jobsPlugin = defineJuniorPlugin({
  manifest: {
    name: "jobs-demo",
    displayName: "Jobs demo",
    description: "Schedules jobs from a route",
  },
  events: {
    resourceTypes: [{ type: "demo", supportedEvents: ["demo.checked"] }],
    events: { "demo.checked": { reach: "resource" } },
  },
  jobs: {
    check: {
      async run(ctx) {
        const { attempt, repo } = ctx.payload as {
          attempt: number;
          repo: string;
        };
        // The queue topic outlives one test run, so skip other runs' jobs.
        if (repo !== currentRepo) return;
        runs.push(ctx.payload);
        watched.push(
          await ctx.events.hasMatch!([
            {
              eventKey: `${repo}:${attempt}`,
              eventType: "demo.checked",
              identifier: repo,
              occurredAtMs: Date.now(),
              trustedSummary: "Checked.",
            },
          ]),
        );
        if (attempt === 1) {
          await ctx.jobs.schedule({
            delayMs: 0,
            name: "check",
            payload: { attempt: 2, repo },
          });
        }
      },
    },
  },
  hooks: {
    routes(ctx) {
      jobs = ctx.jobs;
      return [
        {
          method: "POST",
          path: "/api/webhooks/jobs-demo",
          async handler() {
            for (let i = 0; i < 2; i += 1) {
              await ctx.jobs.schedule({
                delayMs: 0,
                key: `push:${currentRepo}`,
                name: "check",
                payload: { attempt: 1, repo: currentRepo },
              });
            }
            return new Response("Accepted", { status: 202 });
          },
        },
      ];
    },
  },
});

describe("plugin jobs", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    runs = [];
    watched = [];
    currentRepo = `getsentry/${randomUUID()}`;
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await fixture.close();
    await disconnectStateAdapter();
  });

  it("runs a job that a route schedules, once per key, and lets it repeat", async () => {
    const app = await createApp({ plugins: defineJuniorPlugins([jobsPlugin]) });
    worker = await app.startQueueWorker();

    const response = await app.request("/api/webhooks/jobs-demo", {
      method: "POST",
    });
    expect(response.status).toBe(202);

    await waitFor(() => runs.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The second schedule had the same key, so only the repeat ran again.
    expect(runs).toEqual([
      { attempt: 1, repo: currentRepo },
      { attempt: 2, repo: currentRepo },
    ]);
    // The job reads Watches through the plugin's event publisher.
    expect(watched).toEqual([false, false]);
  });

  it("rejects a job that the plugin did not register, or a long delay", async () => {
    await createApp({ plugins: defineJuniorPlugins([jobsPlugin]) });

    await expect(
      jobs!.schedule({ delayMs: 0, name: "missing", payload: null }),
    ).rejects.toThrow('Plugin job "jobs-demo.missing" is not registered');
    await expect(
      jobs!.schedule({ delayMs: 31 * 60_000, name: "check", payload: null }),
    ).rejects.toThrow("delay must be");
  });
});
