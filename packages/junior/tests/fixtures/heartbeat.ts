import path from "node:path";
import { vi } from "vitest";
import {
  createSchedulerSqlStore,
  type ScheduledTask,
} from "@sentry/junior-scheduler";
import type { Destination, PluginDb } from "@sentry/junior-plugin-api";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import {
  createPluginDbForExecutor,
  readPluginMigrations,
} from "@/chat/plugins/db";
import * as pluginDbModule from "@/chat/plugins/db";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { createLocalJuniorSqlFixture } from "./sql";
import { mockTestClock } from "./vitest";

export const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");
export const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
export const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} satisfies Destination;

let schedulerSqlFixture:
  | Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>
  | undefined;
let schedulerPluginDb: PluginDb | undefined;

/** Reset shared heartbeat dependencies before each integration case. */
export async function setupHeartbeatTestEnv(): Promise<void> {
  mockTestClock(TEST_NOW_MS);
  process.env.JUNIOR_SCHEDULER_SECRET = "heartbeat-secret";
  process.env.JUNIOR_BASE_URL = "https://junior.example.com";
  process.env.JUNIOR_SECRET = "dispatch-secret";
  delete process.env.CRON_SECRET;
  setPlugins([]);
  await disconnectStateAdapter();
}

/** Restore heartbeat test globals that route and plugin tests mutate. */
export async function resetHeartbeatTestEnv(
  originalFetch: typeof fetch,
): Promise<void> {
  global.fetch = originalFetch;
  setPlugins([]);
  await schedulerSqlFixture?.close();
  schedulerSqlFixture = undefined;
  schedulerPluginDb = undefined;
  await disconnectStateAdapter();
  delete process.env.JUNIOR_SCHEDULER_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.JUNIOR_BASE_URL;
  delete process.env.JUNIOR_SECRET;
  vi.restoreAllMocks();
  vi.useRealTimers();
}

/** Build an authenticated internal heartbeat request. */
export function heartbeatRequest(): Request {
  return new Request("https://example.invalid/api/internal/heartbeat", {
    headers: { authorization: "Bearer heartbeat-secret" },
  });
}

function schedulerMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-scheduler/migrations");
}

async function migrateSchedulerSchema(
  fixture: Awaited<ReturnType<typeof createLocalJuniorSqlFixture>>,
) {
  for (const migration of readPluginMigrations({
    dir: schedulerMigrationsDir(),
    pluginName: "scheduler",
  })) {
    await fixture.client.exec(migration.sql);
  }
}

/** Build the scheduler store through the plugin SQL boundary. */
export async function schedulerStore() {
  schedulerSqlFixture = await createLocalJuniorSqlFixture();
  await migrateSchedulerSchema(schedulerSqlFixture);
  schedulerPluginDb = createPluginDbForExecutor(schedulerSqlFixture.executor);
  vi.spyOn(pluginDbModule, "getPluginDbForRegistration").mockImplementation(
    (plugin) => (plugin.database ? schedulerPluginDb : undefined),
  );
  return createSchedulerSqlStore(schedulerPluginDb);
}

/** Build a one-off scheduler task with stable clock values. */
export function createTask(
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask {
  const nextRunAtMs = TEST_RUN_AT_MS;
  return {
    id: "sched_plugin_1",
    createdAtMs: nextRunAtMs,
    createdBy: { slackUserId: "U123" },
    destination: SLACK_DESTINATION,
    nextRunAtMs,
    schedule: {
      description: "Once at noon",
      kind: "one_off",
      timezone: "UTC",
    },
    status: "active",
    task: {
      text: "Post a digest. Summarize the latest state.",
    },
    updatedAtMs: nextRunAtMs,
    version: 1,
    ...overrides,
  };
}

/** Build a daily scheduler task that is stale relative to the heartbeat clock. */
export function createDailyTask(
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask {
  const nextRunAtMs = Date.parse("2026-05-24T12:00:00.000Z");
  return createTask({
    id: "sched_plugin_daily",
    createdAtMs: nextRunAtMs,
    nextRunAtMs,
    schedule: {
      description: "Daily at noon UTC",
      kind: "recurring",
      timezone: "UTC",
      recurrence: {
        frequency: "daily",
        interval: 1,
        startDate: "2026-05-24",
        time: {
          hour: 12,
          minute: 0,
        },
      },
    },
    updatedAtMs: nextRunAtMs,
    ...overrides,
  });
}

/** Capture dispatch callback requests while preserving mocked Slack API traffic. */
export function mockDispatchCallbackFetch(originalFetch: typeof fetch) {
  const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://slack.com/api/")) {
      return await originalFetch(...args);
    }
    return new Response("Accepted", { status: 202 });
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

/** Create a valid direct Slack credential subject for dispatch tests. */
export function createCredentialSubject(
  input: {
    channelId?: string;
    teamId?: string;
    userId?: string;
  } = {},
) {
  const subject = createSlackDirectCredentialSubject({
    channelId: input.channelId ?? "D123",
    teamId: input.teamId ?? "T123",
    userId: input.userId ?? "U123",
  });
  if (!subject) {
    throw new Error("Expected test credential subject to be created");
  }
  return subject;
}

/** Persist only the active turn marker needed by heartbeat resume recovery. */
export async function persistActiveTurn(
  conversationId: string,
  activeTurnId?: string,
): Promise<void> {
  await persistThreadStateById(conversationId, {
    conversation: {
      schemaVersion: 1,
      backfill: {},
      compactions: [],
      messages: [],
      piMessages: [],
      processing: {
        activeTurnId,
      },
      stats: {
        compactedMessageCount: 0,
        estimatedContextTokens: 0,
        totalMessageCount: 0,
        updatedAtMs: TEST_NOW_MS,
      },
      vision: {
        byFileId: {},
      },
    },
  });
}
