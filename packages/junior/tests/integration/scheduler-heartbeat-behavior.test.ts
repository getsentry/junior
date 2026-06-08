import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schedulerPlugin } from "@sentry/junior-scheduler";
import {
  getDispatchRecord,
  getDispatchStorageKey,
  updateDispatchRecord,
  withDispatchLock,
} from "@/chat/agent-dispatch/store";
import type { DispatchRecord } from "@/chat/agent-dispatch/types";
import { getStateAdapter } from "@/chat/state/adapter";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { GET as heartbeat } from "@/handlers/heartbeat";
import {
  createDailyTask,
  createTask,
  heartbeatRequest,
  mockDispatchCallbackFetch,
  resetHeartbeatTestEnv,
  schedulerStore,
  setupHeartbeatTestEnv,
  TEST_RUN_AT_MS,
  TEST_NOW_MS,
} from "../fixtures/heartbeat";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("scheduler heartbeat behavior", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await setupHeartbeatTestEnv();
  });

  afterEach(async () => {
    await resetHeartbeatTestEnv(originalFetch);
  });

  it("dispatches and reconciles scheduled runs from the scheduler plugin", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    await store.saveTask(createTask());

    const firstWaitUntil = createWaitUntilCollector();
    const firstResponse = await heartbeat(
      heartbeatRequest(),
      firstWaitUntil.fn,
    );
    expect(firstResponse.status).toBe(202);
    await firstWaitUntil.flush();

    const running = await store.getRun(`sched_plugin_1:${TEST_RUN_AT_MS}`);
    expect(running).toMatchObject({
      status: "running",
      dispatchId: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await withDispatchLock(running!.dispatchId!, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(running!.dispatchId!),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        resultMessageTs: "1700000000.000001",
        status: "completed",
      });
    });

    const secondWaitUntil = createWaitUntilCollector();
    const secondResponse = await heartbeat(
      heartbeatRequest(),
      secondWaitUntil.fn,
    );
    expect(secondResponse.status).toBe(202);
    await secondWaitUntil.flush();

    await expect(store.getRun(running!.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000001",
    });
    await expect(store.getTask("sched_plugin_1")).resolves.toMatchObject({
      lastRunAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      status: "paused",
    });
  });

  it("exposes sanitized scheduler operational reports through Junior reporting", async () => {
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    await store.saveTask(
      createTask({
        createdBy: {
          slackUserId: "U123",
          fullName: "Alice Reviewer",
          userName: "alice",
        },
        task: {
          text: "Secret task text that must stay out of dashboard stats.",
        },
      }),
    );
    await store.saveTask(
      createTask({
        createdBy: {
          slackUserId: "U456",
          fullName: "W039RR91S",
          userName: "U456",
        },
        id: "sched_plugin_blocked",
        status: "blocked",
        statusReason: "Secret blocked reason",
        task: {
          text: "Secret blocked task text",
        },
        updatedAtMs: TEST_NOW_MS,
      }),
    );
    await store.saveTask(
      createTask({
        createdBy: {
          slackUserId: "unknown",
        },
        id: "sched_plugin_corrupt_creator",
        status: "blocked",
        task: {
          text: "Corrupt creator metadata task",
        },
        updatedAtMs: TEST_NOW_MS + 1,
      }),
    );

    const { createJuniorReporting } = await import("@/reporting");
    const feed = await createJuniorReporting().getPluginOperationalReports();
    const scheduler = feed.reports.find(
      (report) => report.pluginName === "scheduler",
    );

    expect(feed.source).toBe("plugins");
    expect(scheduler).toMatchObject({
      pluginName: "scheduler",
      title: "Scheduler",
    });
    expect(scheduler?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "active", value: "1" }),
        expect.objectContaining({ label: "blocked", value: "2" }),
        expect.objectContaining({ label: "due now", value: "1" }),
      ]),
    );
    expect(scheduler?.recordSets?.map((recordSet) => recordSet.title)).toEqual([
      "Upcoming",
      "Blocked",
      "Running",
    ]);
    expect(scheduler?.recordSets?.[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "author", label: "Author" }),
      ]),
    );
    expect(
      scheduler?.recordSets?.[0]?.records?.[0]?.values ?? {},
    ).toMatchObject({
      author: "Alice Reviewer (@alice)",
    });
    const blockedRecords = scheduler?.recordSets?.[1]?.records ?? [];
    expect(
      blockedRecords.find((record) => record.id === "sched_plugin_blocked")
        ?.values ?? {},
    ).toMatchObject({
      author: "Slack User U456",
    });
    expect(
      blockedRecords.find(
        (record) => record.id === "sched_plugin_corrupt_creator",
      )?.values ?? {},
    ).toMatchObject({
      author: "Invalid Slack creator metadata",
    });
    expect(JSON.stringify(feed)).not.toContain("Secret");
  });

  it("counts all running scheduler runs in operational summaries", async () => {
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    for (let index = 0; index < 6; index += 1) {
      await store.saveTask(
        createTask({
          id: `sched_running_${index}`,
          createdAtMs: TEST_RUN_AT_MS + index,
          updatedAtMs: TEST_RUN_AT_MS + index,
        }),
      );
    }
    for (let index = 0; index < 6; index += 1) {
      await expect(
        store.claimDueRun({ nowMs: TEST_NOW_MS + index }),
      ).resolves.toBeDefined();
    }

    const { createJuniorReporting } = await import("@/reporting");
    const feed = await createJuniorReporting().getPluginOperationalReports();
    const scheduler = feed.reports.find(
      (report) => report.pluginName === "scheduler",
    );
    const runningSummary = scheduler?.metrics?.find(
      (metric) => metric.label === "running",
    );
    const runningSection = scheduler?.recordSets?.find(
      (recordSet) => recordSet.title === "Running",
    );

    expect(runningSummary).toMatchObject({ value: "6" });
    expect(runningSection?.records).toHaveLength(5);
  });

  it("carries scheduled task credential subjects into dispatch records", async () => {
    mockDispatchCallbackFetch(originalFetch);
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    await store.saveTask(
      createTask({
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
        },
      }),
    );

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn);
    expect(response.status).toBe(202);
    await waitUntil.flush();

    const running = await store.getRun(`sched_plugin_1:${TEST_RUN_AT_MS}`);
    expect(running?.dispatchId).toEqual(expect.any(String));
    await expect(
      getDispatchRecord(running!.dispatchId!),
    ).resolves.toMatchObject({
      credentialSubject: {
        type: "user",
        userId: "U123",
        allowedWhen: "private-direct-conversation",
        binding: {
          type: "slack-direct-conversation",
          teamId: "T123",
          channelId: "D123",
          signature: expect.any(String),
        },
      },
    });
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
  });

  it("fails scheduled runs when their dispatch record disappeared", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    await store.saveTask(createTask());

    const firstWaitUntil = createWaitUntilCollector();
    const firstResponse = await heartbeat(
      heartbeatRequest(),
      firstWaitUntil.fn,
    );
    expect(firstResponse.status).toBe(202);
    await firstWaitUntil.flush();

    const running = await store.getRun(`sched_plugin_1:${TEST_RUN_AT_MS}`);
    expect(running).toMatchObject({
      status: "running",
      dispatchId: expect.any(String),
    });
    const state = getStateAdapter();
    await state.connect();
    await state.delete(getDispatchStorageKey(running!.dispatchId!));

    const secondWaitUntil = createWaitUntilCollector();
    const secondResponse = await heartbeat(
      heartbeatRequest(),
      secondWaitUntil.fn,
    );
    expect(secondResponse.status).toBe(202);
    await secondWaitUntil.flush();

    await expect(store.getRun(running!.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Scheduled task dispatch record is missing.",
    });
    await expect(store.getTask("sched_plugin_1")).resolves.toMatchObject({
      status: "paused",
    });
  });

  it("blocks scheduled runs with invalid credential routing without stopping the heartbeat", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    await store.saveTask({
      ...createTask(),
      id: "sched_plugin_bad_credential_route",
      credentialSubject: {
        type: "user",
        userId: "U123",
        allowedWhen: "private-direct-conversation",
      },
    });

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn);
    expect(response.status).toBe(202);
    await waitUntil.flush();

    await expect(
      store.getRun(`sched_plugin_bad_credential_route:${TEST_RUN_AT_MS}`),
    ).resolves.toMatchObject({
      status: "blocked",
      errorMessage: expect.stringContaining(
        "Scheduled task dispatch could not be created",
      ),
    });
    await expect(
      store.getTask("sched_plugin_bad_credential_route"),
    ).resolves.toMatchObject({
      status: "blocked",
      statusReason: expect.stringContaining(
        "Scheduled task dispatch could not be created",
      ),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips old recurring occurrences and advances to the next future run", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    const task = createDailyTask();
    await store.saveTask(task);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn);
    expect(response.status).toBe(202);
    await waitUntil.flush();

    await expect(
      store.getRun(`${task.id}:${task.nextRunAtMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      errorMessage: expect.stringContaining("more than 24 hours late"),
    });
    await expect(store.getTask(task.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-05-27T12:00:00.000Z"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedupes equivalent old recurring tasks during heartbeat recovery", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;
    setPlugins([schedulerPlugin()]);
    const store = await schedulerStore();
    const first = createDailyTask({
      id: "sched_plugin_duplicate_a",
      createdAtMs: Date.parse("2026-05-24T12:00:00.000Z"),
    });
    const duplicate = createDailyTask({
      id: "sched_plugin_duplicate_b",
      createdAtMs: Date.parse("2026-05-24T12:00:01.000Z"),
    });
    await store.saveTask(first);
    await store.saveTask(duplicate);

    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn);
    expect(response.status).toBe(202);
    await waitUntil.flush();

    await expect(
      store.getRun(`${duplicate.id}:${duplicate.nextRunAtMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      errorMessage: expect.stringContaining(
        "Duplicate stale scheduled task was skipped",
      ),
    });
    await expect(store.getTask(first.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-05-27T12:00:00.000Z"),
    });
    await expect(store.getTask(duplicate.id)).resolves.toMatchObject({
      status: "paused",
      statusReason: expect.stringContaining(first.id),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
