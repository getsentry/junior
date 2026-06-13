import path from "node:path";
import { vi } from "vitest";
import {
  PluginToolInputError,
  type PluginDb,
  type PluginToolDefinition,
  type SlackDestination,
} from "@sentry/junior-plugin-api";
import {
  createSchedulerSqlStore,
  createSlackScheduleCreateTaskTool as makeSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool as makeSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool as makeSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool as makeSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool as makeSlackScheduleUpdateTaskTool,
  type SchedulerToolContext,
} from "@sentry/junior-scheduler";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import {
  createPluginDbForExecutor,
  readPluginMigrations,
} from "@/chat/plugins/db";
import * as pluginDbModule from "@/chat/plugins/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../sql";
import { DEFAULT_TEST_NOW_MS, mockTestClock } from "../vitest";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

export { PluginToolInputError };

export const TEST_TEAM_ID = `TSCHEDULE${DEFAULT_TEST_NOW_MS}`;
let currentFixture: LocalJuniorSqlFixture | undefined;
let currentSchedulerStore: SchedulerToolContext["store"] | undefined;

type CreateContextOverrides = Partial<SchedulerToolContext> & {
  channelId?: string;
  teamId?: string;
};

function schedulerMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-scheduler/migrations");
}

async function migrateSchedulerSchema(
  fixture: LocalJuniorSqlFixture,
): Promise<void> {
  for (const migration of readPluginMigrations({
    dir: schedulerMigrationsDir(),
    pluginName: "scheduler",
  })) {
    await fixture.client.exec(migration.sql);
  }
}

/** Build the scheduler plugin SQL store used by schedule tool tests. */
export async function initializeSchedulerSqlStore(): Promise<{
  fixture: LocalJuniorSqlFixture;
  store: SchedulerToolContext["store"];
}> {
  const fixture = await createLocalJuniorSqlFixture();
  await migrateSchedulerSchema(fixture);
  const db: PluginDb = createPluginDbForExecutor(fixture.executor);
  vi.spyOn(pluginDbModule, "getPluginDbForRegistration").mockImplementation(
    (plugin) => (plugin.database ? db : undefined),
  );
  const store = createSchedulerSqlStore(db);
  currentFixture = fixture;
  currentSchedulerStore = store;
  return { fixture, store };
}

async function cleanupSchedulerSqlStore(): Promise<void> {
  await currentFixture?.close();
  currentFixture = undefined;
  currentSchedulerStore = undefined;
}

/** Creates the Slack schedule create tool for the supplied test context. */
export function createSlackScheduleCreateTaskTool(
  context: SchedulerToolContext,
) {
  return makeSlackScheduleCreateTaskTool(context);
}

/** Creates the Slack schedule delete tool for the supplied test context. */
export function createSlackScheduleDeleteTaskTool(
  context: SchedulerToolContext,
) {
  return makeSlackScheduleDeleteTaskTool(context);
}

/** Creates the Slack schedule list tool for the supplied test context. */
export function createSlackScheduleListTasksTool(
  context: SchedulerToolContext,
) {
  return makeSlackScheduleListTasksTool(context);
}

/** Creates the Slack schedule run-now tool for the supplied test context. */
export function createSlackScheduleRunTaskNowTool(
  context: SchedulerToolContext,
) {
  return makeSlackScheduleRunTaskNowTool(context);
}

/** Creates the Slack schedule update tool for the supplied test context. */
export function createSlackScheduleUpdateTaskTool(
  context: SchedulerToolContext,
) {
  return makeSlackScheduleUpdateTaskTool(context);
}

/** Builds the default Slack scheduler tool context shared by schedule tests. */
export function createContext(
  overrides: CreateContextOverrides = {},
): SchedulerToolContext {
  const {
    channelId = "C123",
    teamId = TEST_TEAM_ID,
    source: overrideSource,
    ...contextOverrides
  } = overrides;
  const source =
    overrideSource ??
    ({
      platform: "slack",
      teamId,
      channelId,
    } satisfies SlackDestination);
  const context: SchedulerToolContext = {
    source,
    requester: {
      platform: "slack",
      teamId,
      userId: "U123",
      userName: "dcramer",
      fullName: "David Cramer",
    },
    userText: "schedule this weekly",
    store: schedulerStore(),
    ...contextOverrides,
  };
  const credentialSubject =
    context.credentialSubject ??
    createSlackDirectCredentialSubject({
      channelId: context.source?.channelId,
      teamId: context.source?.teamId,
      userId: context.requester?.userId,
    });
  return {
    ...context,
    ...(credentialSubject ? { credentialSubject } : {}),
  };
}

/** Runs a scheduler tool through the production execute contract. */
export async function executeTool<TInput, TResult>(
  tool: PluginToolDefinition<TInput>,
  input: TInput,
): Promise<Awaited<TResult>> {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {});
}

/** Opens the SQL-backed scheduler store used by schedule tool tests. */
export function schedulerStore() {
  if (!currentSchedulerStore) {
    throw new Error("Scheduler SQL store is not initialized");
  }
  return currentSchedulerStore;
}

/** Creates the standard weekly scheduler task used by update and run tests. */
export async function createTask(
  context = createContext(),
  overrides: Record<string, unknown> = {},
) {
  const tool = createSlackScheduleCreateTaskTool(context);
  return await executeTool(tool, {
    task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
    schedule: "Every Monday at 9am",
    timezone: "America/Los_Angeles",
    next_run_at: "2026-05-25T16:00:00.000Z",
    recurrence: "weekly",
    ...overrides,
  });
}

/** Resets persistent state before each scheduler tool scenario. */
export async function setupSlackScheduleToolTest() {
  setPlugins([]);
  mockTestClock();
  await disconnectStateAdapter();
  await initializeSchedulerSqlStore();
}

/** Restores timers, environment, and memory state after scheduler tool tests. */
export async function cleanupSlackScheduleToolTest() {
  vi.useRealTimers();
  delete process.env.JUNIOR_TIMEZONE;
  setPlugins([]);
  await cleanupSchedulerSqlStore();
  vi.restoreAllMocks();
  await disconnectStateAdapter();
}
