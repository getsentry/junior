import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { getDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity } from "@/chat/identities/sql";
import {
  getDispatchConversationId,
  getDispatchRecord,
  getDispatchStorageKey,
  markDispatchBlocked,
  markDispatchCompleted,
} from "@/chat/agent-dispatch/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { GET as heartbeat } from "@/handlers/heartbeat";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_NOW_MS = Date.parse("2026-05-26T12:05:00.000Z");
const TEST_RUN_AT_MS = Date.parse("2026-05-26T12:00:00.000Z");
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} satisfies Destination;
let conversationWorkQueue = createConversationWorkQueueTestAdapter();
let creatorIdentityId = "";

function testHeartbeat(
  request: Parameters<typeof heartbeat>[0],
  waitUntil: Parameters<typeof heartbeat>[1],
  options: Parameters<typeof heartbeat>[2] = {},
) {
  return heartbeat(request, waitUntil, {
    ...options,
    conversationWorkQueue:
      options.conversationWorkQueue ?? conversationWorkQueue,
  });
}

/** Run one authorized heartbeat and wait for the work it started. */
async function runAuthorizedHeartbeat(): Promise<void> {
  const waitUntil = createWaitUntilCollector();
  const response = await testHeartbeat(
    new Request("https://example.invalid/api/internal/heartbeat", {
      headers: { authorization: "Bearer heartbeat-secret" },
    }),
    waitUntil.fn,
  );
  expect(response.status).toBe(202);
  await waitUntil.flush();
}

const scheduledAutomationDb = (): JuniorDatabase => getDb();
async function readScheduledRun(db: JuniorDatabase, id: string) {
  const [row] = await db
    .select()
    .from(juniorAutomationRuns)
    .where(eq(juniorAutomationRuns.id, id));
  return row;
}

function createTask(
  overrides: Partial<ScheduledAutomation> = {},
): ScheduledAutomation {
  const nextRunAtMs = TEST_RUN_AT_MS;
  return {
    id: "sched_plugin_1",
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: nextRunAtMs,
    createdBy: { slackUserId: "U123" },
    creatorIdentityId,
    credentialMode: "system",
    destination: SLACK_DESTINATION,
    outcomes: [{ action: "send_message", destination: SLACK_DESTINATION }],
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
    ...overrides,
  };
}

function createDailyTask(
  overrides: Partial<ScheduledAutomation> = {},
): ScheduledAutomation {
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

describe("scheduled automation heartbeat", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    conversationWorkQueue = createConversationWorkQueueTestAdapter();
    vi.useFakeTimers({ now: TEST_NOW_MS });
    process.env.JUNIOR_SCHEDULER_SECRET = "heartbeat-secret";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "dispatch-secret";
    await disconnectStateAdapter();
    creatorIdentityId = (
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: "T123",
        providerSubjectId: "U123",
      })
    ).id;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await disconnectStateAdapter();
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("dispatches and reconciles scheduled runs from the core heartbeat", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    const db = scheduledAutomationDb();
    await saveScheduledAutomation(
      db,
      createTask({
        createdBy: {
          slackUserId: "U039RR91S",
          userName: "U039RR91S",
          fullName: "W039RR91S",
        },
        schedule: {
          description: "Once\nat noon",
          kind: "one_off",
          timezone: "UTC",
        },
      }),
    );

    await runAuthorizedHeartbeat();

    const running = await readScheduledRun(
      db,
      `sched_plugin_1:${TEST_RUN_AT_MS}`,
    );
    // The run stores the Automation version that it dispatched.
    expect(running).toMatchObject({
      automationVersion: 1,
      status: "running",
      dispatchId: expect.any(String),
    });
    // The run links its Conversation when it is dispatched.
    expect(running?.conversationId).toBe(
      getDispatchConversationId({ id: running!.dispatchId! }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(conversationWorkQueue.sentRecords()).toHaveLength(1);
    const dispatchRecord = await getDispatchRecord(running!.dispatchId!);
    expect(dispatchRecord?.input).toContain("[task]");
    expect(dispatchRecord?.input).not.toContain("[[NO_REPLY]]");
    expect(dispatchRecord?.input).toContain("Created by: <@U039RR91S>");
    expect(dispatchRecord?.input).toContain(
      "Instructions: Post a digest. Summarize the latest state.",
    );
    expect(dispatchRecord?.destination).toEqual(SLACK_DESTINATION);
    expect(dispatchRecord?.destinationVisibility).toBe("public");
    expect(dispatchRecord?.source).toEqual({ kind: "scheduled_automation" });
    expect(dispatchRecord?.metadata).toMatchObject({
      runId: `sched_plugin_1:${TEST_RUN_AT_MS}`,
      schedule: "Once at noon",
      scheduleKind: "one_off",
      scheduledFor: "2026-05-26T12:00:00.000Z",
      runningAt: "2026-05-26T12:05:00.000Z",
      taskId: "sched_plugin_1",
      timezone: "UTC",
    });
    expect(dispatchRecord?.metadata).not.toHaveProperty("creatorSlackUserId");
    expect(dispatchRecord?.metadata).not.toHaveProperty("creatorUserName");
    expect(dispatchRecord?.metadata).not.toHaveProperty("creatorFullName");
    expect(dispatchRecord?.replyAttribution).toEqual({
      label: "Automation",
    });

    await markDispatchCompleted(running!.dispatchId!, "1700000000.000001");

    await runAuthorizedHeartbeat();

    await expect(readScheduledRun(db, running!.id)).resolves.toMatchObject({
      automationVersion: 1,
      status: "completed",
      resultMessageTs: "1700000000.000001",
    });
    await expect(
      readScheduledAutomation(db, "sched_plugin_1"),
    ).resolves.toMatchObject({
      lastRunAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      status: "completed",
    });
  }, 30_000);

  it.each([
    {
      conversationAccess: {
        audience: "channel",
        visibility: "public",
      } as const,
      destination: SLACK_DESTINATION,
      label: "channel",
    },
    {
      conversationAccess: {
        audience: "direct",
        visibility: "private",
      } as const,
      destination: { ...SLACK_DESTINATION, channelId: "D123" },
      label: "DM",
    },
  ])(
    "binds creator credentials to the scheduled automation dispatch in a $label",
    async ({ conversationAccess, destination }) => {
      const db = scheduledAutomationDb();
      await saveScheduledAutomation(
        db,
        createTask({
          conversationAccess,
          credentialMode: "creator",
          destination,
        }),
      );

      await runAuthorizedHeartbeat();

      const running = await readScheduledRun(
        db,
        `sched_plugin_1:${TEST_RUN_AT_MS}`,
      );
      expect(running?.dispatchId).toEqual(expect.any(String));
      await expect(
        getDispatchRecord(running!.dispatchId!),
      ).resolves.toMatchObject({
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "scheduled-automation",
          taskId: "sched_plugin_1",
          binding: {
            type: "scheduled-automation",
            plugin: "scheduler",
            taskId: "sched_plugin_1",
            signature: expect.any(String),
          },
        },
        destination,
      });
      expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    },
    30_000,
  );

  it.each([
    { case: "blocks it", change: undefined, status: "blocked", notices: 1 },
    // The creator moved the schedule during the run, so it stays active.
    {
      case: "keeps it active",
      change: { nextRunAtMs: TEST_RUN_AT_MS + 24 * 60 * 60 * 1000 },
      status: "active",
      notices: 0,
    },
    // The creator paused it during the run. The dashboard shows paused, so
    // a notice that says blocked would be wrong.
    {
      case: "keeps it paused",
      change: { status: "paused" as const },
      status: "paused",
      notices: 0,
    },
  ])(
    "tells the creator about a blocked run only when the heartbeat $case",
    async ({ change, status, notices: expectedNotices }) => {
      const db = scheduledAutomationDb();
      await saveScheduledAutomation(db, createTask());
      const notices = () => getCapturedSlackApiCalls("conversations.open");
      await runAuthorizedHeartbeat();
      const run = await readScheduledRun(
        db,
        `sched_plugin_1:${TEST_RUN_AT_MS}`,
      );
      await markDispatchBlocked(run!.dispatchId!, "Channel archived.");
      if (change) {
        const current = await readScheduledAutomation(db, "sched_plugin_1");
        await saveScheduledAutomation(db, { ...current!, ...change });
      }
      // The Scheduled automation is still active, so no notice goes yet.
      expect(notices()).toHaveLength(0);
      await runAuthorizedHeartbeat();
      await runAuthorizedHeartbeat();
      const task = await readScheduledAutomation(db, "sched_plugin_1");
      expect(task).toMatchObject({ status });
      expect(notices()).toHaveLength(expectedNotices);
    },
    30_000,
  );

  it("settles a run whose Scheduled automation was deleted while it ran", async () => {
    const db = scheduledAutomationDb();
    const task = createTask();
    await saveScheduledAutomation(db, task);
    await runAuthorizedHeartbeat();
    const running = await readScheduledRun(db, `${task.id}:${TEST_RUN_AT_MS}`);
    await saveScheduledAutomation(db, {
      ...task,
      nextRunAtMs: undefined,
      status: "deleted",
    });

    await markDispatchCompleted(running!.dispatchId!);
    await runAuthorizedHeartbeat();

    await expect(readScheduledRun(db, running!.id)).resolves.toMatchObject({
      status: "completed",
    });
  }, 30_000);

  it("fails scheduled runs when their dispatch record disappeared", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    const db = scheduledAutomationDb();
    await saveScheduledAutomation(db, createTask());

    await runAuthorizedHeartbeat();

    const running = await readScheduledRun(
      db,
      `sched_plugin_1:${TEST_RUN_AT_MS}`,
    );
    expect(running).toMatchObject({
      status: "running",
      dispatchId: expect.any(String),
    });
    const state = getStateAdapter();
    await state.connect();
    await state.delete(getDispatchStorageKey(running!.dispatchId!));

    await runAuthorizedHeartbeat();

    await expect(readScheduledRun(db, running!.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Scheduled automation dispatch record is missing.",
    });
    await expect(
      readScheduledAutomation(db, "sched_plugin_1"),
    ).resolves.toMatchObject({
      status: "deleted",
    });
  }, 30_000);

  it("blocks malformed scheduled automations without stopping the core heartbeat", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    const db = scheduledAutomationDb();
    await saveScheduledAutomation(db, {
      ...createTask(),
      id: "sched_plugin_malformed",
      task: { text: "" },
    });
    const waitUntil = createWaitUntilCollector();
    const request = new Request(
      "https://example.invalid/api/internal/heartbeat",
      {
        headers: { authorization: "Bearer heartbeat-secret" },
      },
    );
    const response = await testHeartbeat(request, waitUntil.fn);
    expect(response.status).toBe(202);
    await waitUntil.flush();

    await expect(
      readScheduledRun(db, `sched_plugin_malformed:${TEST_RUN_AT_MS}`),
    ).resolves.toMatchObject({
      status: "blocked",
      errorMessage: expect.stringContaining(
        "Scheduled automation dispatch metadata could not be built",
      ),
    });
    const blockedTask = await readScheduledAutomation(
      db,
      "sched_plugin_malformed",
    );
    expect(blockedTask).toMatchObject({
      status: "blocked",
      statusReason: expect.stringContaining(
        "Scheduled automation dispatch metadata could not be built",
      ),
    });
    // A block before dispatch tells the creator too.
    expect(getCapturedSlackApiCalls("conversations.open")).toHaveLength(1);
    await saveScheduledAutomation(db, {
      ...blockedTask!,
      nextRunAtMs: TEST_RUN_AT_MS,
      status: "active",
      statusReason: undefined,
      task: { text: "Post the recovered digest." },
      updatedAtMs: TEST_NOW_MS + 1,
    });
    const retryWaitUntil = createWaitUntilCollector();
    await testHeartbeat(request, retryWaitUntil.fn);
    await retryWaitUntil.flush();
    await expect(
      readScheduledRun(db, `sched_plugin_malformed:${TEST_RUN_AT_MS}`),
    ).resolves.toMatchObject({
      status: "running",
      dispatchId: expect.any(String),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it("skips old recurring occurrences and advances to the next future run", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    const db = scheduledAutomationDb();
    const task = createDailyTask();
    await saveScheduledAutomation(db, task);

    await runAuthorizedHeartbeat();

    await expect(
      readScheduledRun(db, `${task.id}:${task.nextRunAtMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      errorMessage: expect.stringContaining("more than 24 hours late"),
    });
    await expect(readScheduledAutomation(db, task.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-05-27T12:00:00.000Z"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);

  it("dedupes equivalent old recurring tasks during heartbeat recovery", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    const db = scheduledAutomationDb();
    const first = createDailyTask({
      id: "sched_plugin_duplicate_a",
      createdAtMs: Date.parse("2026-05-24T12:00:00.000Z"),
    });
    const duplicate = createDailyTask({
      id: "sched_plugin_duplicate_b",
      createdAtMs: Date.parse("2026-05-24T12:00:01.000Z"),
    });
    await saveScheduledAutomation(db, first);
    await saveScheduledAutomation(db, duplicate);

    await runAuthorizedHeartbeat();

    await expect(
      readScheduledRun(db, `${duplicate.id}:${duplicate.nextRunAtMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      errorMessage: expect.stringContaining(
        "Duplicate stale scheduled automation was skipped",
      ),
    });
    await expect(readScheduledAutomation(db, first.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-05-27T12:00:00.000Z"),
    });
    const duplicateTask = await readScheduledAutomation(db, duplicate.id);
    expect(duplicateTask).toMatchObject({
      status: "deleted",
      statusReason: expect.stringContaining(first.id),
    });
    expect(duplicateTask).not.toHaveProperty("nextRunAtMs");
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30_000);
});
