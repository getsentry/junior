import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  cacheWarmingSavingsRefillResponseSchema,
  cacheWarmingSavingsReportSchema,
} from "@/api/schema";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { backfillCacheWarmingGaps } from "@/chat/cache-warming/backfill";
import { NO_REPLY_GAP_MS } from "@/chat/cache-warming/model";
import { recordWarmupCost } from "@/chat/cache-warming/savings";
import { runSavingsRefillSlice } from "@/chat/cache-warming/savings-refill";
import { GLOBAL_GAPS_TTL_MS } from "@/chat/cache-warming/warmup";
import {
  agentInstructionProvenance,
  contextProvenance,
  instructionProvenanceFor,
} from "@/chat/conversations/provenance";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";
import { resolveGatewayModel } from "@/chat/pi/client";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import { getStateAdapter } from "@/chat/state/adapter";
import { createAgent } from "../fixtures/agent";
import { closeConversationFixture } from "../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { mockTitleModel } from "../fixtures/title-model";
import type { AgentRequestStreamFn } from "@/chat/pi/agent-history";

const MINUTE = 60_000;
const BACKFILL_KEY = "junior:cache_warming:backfill:work_state:v2";
// Older releases wrote `done` here with no TTL.
const LEGACY_BACKFILL_KEY = "junior:cache_warming:backfill:work_state";
const REFILL_KEY = "junior:cache_warming:savings_refill:v1";
const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const SEGMENTS = [
  "user:1:none",
  "user:2-3:none",
  "user:4+:none",
  "system:1:none",
  "system:2-3:none",
  "system:4+:none",
];

function reply(
  prefixTokens: number,
  startedAtMs = Date.now(),
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 10,
      output: 10,
      cacheRead: prefixTokens,
      cacheWrite: 0,
      totalTokens: prefixTokens + 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    // Pi sets this when the request starts.
    timestamp: startedAtMs,
  };
}

// Run one Turn per entry through the real Conversation path. Each Turn makes
// one model request at its own time, with its own cached prefix size.
async function runTurns(turns: Array<{ atMs: number; prefixTokens: number }>) {
  let request = 0;
  // The faux provider estimates its own usage, so this stream sets it.
  const modelStream: AgentRequestStreamFn = () => {
    const stream = createAssistantMessageEventStream();
    const message = reply(turns[request++]!.prefixTokens);
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  // This OpenAI model is never warmed, so live recording writes no gaps
  // while these Turns run.
  const agent = await createAgent({
    modelStream,
    botConfig: { modelId: "openai/gpt-5.5" },
  });
  for (const [index, turn] of turns.entries()) {
    vi.setSystemTime(turn.atMs);
    await agent.run(`Question ${index + 1}`);
  }
  return agent.conversationId();
}

const gaps = (segment: string) =>
  getStateAdapter().getList<number>(`junior:cache_warming:gaps:${segment}`);

async function heartbeat(nowMs: number) {
  vi.setSystemTime(nowMs);
  await runHeartbeat({
    conversationWorkQueue: createConversationWorkQueueTestAdapter(),
    nowMs,
  });
}

describe("cache warming gap backfill", () => {
  afterEach(async () => {
    vi.useRealTimers();
    const state = getStateAdapter();
    await state.delete(LEGACY_BACKFILL_KEY);
    await state.delete(BACKFILL_KEY);
    await state.delete(REFILL_KEY);
    for (const segment of SEGMENTS) {
      await state.delete(`junior:cache_warming:gaps:${segment}`);
    }
    await closeConversationFixture();
  });

  it("fills each empty gap list from the stored Turns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockTitleModel("Conversation title");
    // An older release completed a run and kept `done` with no TTL. The
    // backfill runs again under its new key.
    await getStateAdapter().set(LEGACY_BACKFILL_KEY, "done");
    // Live recording already has a gap for later Turns of people. The
    // backfill does not add to it.
    await getStateAdapter().appendToList(
      "junior:cache_warming:gaps:user:4+:none",
      1,
    );

    // A person replies 7 minutes after the first Turn and 60 minutes after
    // the second. The third Turn has a prefix too small to warm, so its
    // 2 minute gap is not a gap that live recording would record.
    const conversationId = await runTurns([
      { atMs: T0, prefixTokens: 60_000 },
      { atMs: T0 + 7 * MINUTE, prefixTokens: 60_000 },
      { atMs: T0 + 67 * MINUTE, prefixTokens: 1_000 },
      { atMs: T0 + 69 * MINUTE, prefixTokens: 60_000 },
    ]);
    // Only the parent agent sends Turns to a Task.
    const taskId = `${conversationId}:task`;
    await getConversationStore().createChild({
      childConversationId: taskId,
      kind: "task",
      parentConversationId: conversationId,
      nowMs: T0,
    });
    await getConversationEventStore().append(taskId, [
      {
        createdAtMs: T0 + MINUTE,
        data: historyItemFromPiMessage(
          { role: "user", content: "Check the logs.", timestamp: T0 + MINUTE },
          agentInstructionProvenance,
        ),
      },
      {
        createdAtMs: T0 + 2 * MINUTE,
        data: historyItemFromPiMessage(
          reply(60_000, T0 + MINUTE),
          contextProvenance,
        ),
      },
    ]);
    await heartbeat(T0 + 130 * MINUTE);

    expect(await gaps("user:1:none")).toEqual([7 * MINUTE]);
    expect(await gaps("user:2-3:none")).toEqual([NO_REPLY_GAP_MS]);
    expect(await gaps("user:4+:none")).toEqual([1]);
    expect(await gaps("system:1:none")).toEqual([NO_REPLY_GAP_MS]);

    await getStateAdapter().delete("junior:cache_warming:gaps:user:1:none");
    await heartbeat(T0 + 131 * MINUTE);
    expect(await gaps("user:1:none")).toEqual([]);

    // The completed run expires after the gap list TTL, so a later heartbeat
    // checks for empty lists again.
    vi.setSystemTime(T0 + 130 * MINUTE + GLOBAL_GAPS_TTL_MS - MINUTE);
    expect(await getStateAdapter().get(BACKFILL_KEY)).toBe("done");
    vi.setSystemTime(T0 + 130 * MINUTE + GLOBAL_GAPS_TTL_MS);
    expect(await getStateAdapter().get(BACKFILL_KEY)).toBeNull();
  });

  it("keeps the Actor that started a Turn when a person steers it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conversationId = "local:test:backfill-steer";
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      activityAtMs: T0,
      nowMs: T0,
    });
    const person = instructionProvenanceFor({
      platform: "slack",
      teamId: "T123",
      userId: "U123",
    });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: T0,
        data: historyItemFromPiMessage(
          { role: "user", content: "Run the check.", timestamp: T0 },
          instructionProvenanceFor({ platform: "system", name: "scheduler" }),
        ),
      },
      {
        createdAtMs: T0 + MINUTE / 2,
        data: historyItemFromPiMessage(
          { ...reply(60_000, T0), stopReason: "toolUse" },
          contextProvenance,
        ),
      },
      {
        createdAtMs: T0 + MINUTE / 2,
        data: historyItemFromPiMessage(
          { role: "user", content: "Also check staging.", timestamp: T0 },
          person,
        ),
      },
      {
        createdAtMs: T0 + 2 * MINUTE,
        data: historyItemFromPiMessage(
          reply(60_000, T0 + MINUTE),
          contextProvenance,
        ),
      },
    ]);

    vi.setSystemTime(T0 + 130 * MINUTE);
    await backfillCacheWarmingGaps({ nowMs: T0 + 130 * MINUTE });
    expect(await gaps("system:1:none")).toEqual([NO_REPLY_GAP_MS]);
    expect(await gaps("user:1:none")).toEqual([]);
  });

  it("completes with the gaps it has when its scan budget is used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockTitleModel("Conversation title");
    const conversationId = await runTurns([
      { atMs: T0 + 30 * MINUTE, prefixTokens: 60_000 },
      { atMs: T0 + 37 * MINUTE, prefixTokens: 60_000 },
    ]);
    // A Task that ended long ago. Newest first, it is in the second batch.
    const taskId = `${conversationId}:task`;
    await getConversationStore().createChild({
      childConversationId: taskId,
      kind: "task",
      parentConversationId: conversationId,
      nowMs: T0,
    });
    await getConversationEventStore().append(taskId, [
      {
        createdAtMs: T0 + MINUTE,
        data: historyItemFromPiMessage(
          reply(60_000, T0 + MINUTE),
          contextProvenance,
        ),
      },
    ]);
    // With the person Conversation, these fill the first batch and more.
    for (let i = 0; i < 10; i++) {
      await getConversationStore().recordActivity({
        conversationId: `local:test:backfill-budget:${i}`,
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        activityAtMs: T0 + 20 * MINUTE,
        nowMs: T0 + 20 * MINUTE,
      });
    }

    vi.setSystemTime(T0 + 130 * MINUTE);
    await backfillCacheWarmingGaps({ nowMs: T0 + 130 * MINUTE, budgetMs: 0 });
    expect(await gaps("user:1:none")).toEqual([7 * MINUTE]);
    expect(await gaps("system:1:none")).toEqual([]);

    // The run completed, so a heartbeat does not scan the rest.
    await heartbeat(T0 + 131 * MINUTE);
    expect(await gaps("system:1:none")).toEqual([]);
  });
});

describe("cache warming savings re-fill", () => {
  afterEach(async () => {
    vi.useRealTimers();
    const state = getStateAdapter();
    await state.delete(BACKFILL_KEY);
    await state.delete(REFILL_KEY);
    for (const segment of SEGMENTS) {
      await state.delete(`junior:cache_warming:gaps:${segment}`);
    }
    await closeConversationFixture();
  });

  const MODEL_ID = "anthropic/claude-opus-5.5";
  const DAY_1 = Date.parse("2031-07-01T09:00:00.000Z");
  const DAY_2 = Date.parse("2031-07-02T09:00:00.000Z");
  const ADMIN = "admin@example.com";
  const PERSON = "person@example.com";

  function authenticatedApi(email: string) {
    const app = new Hono<{ Variables: JuniorApiVariables }>();
    app.use("*", async (c, next) => {
      const viewer = await resolveViewerUser(email);
      if (!viewer) throw new Error(`missing viewer for ${email}`);
      c.set("viewer", viewer);
      await next();
    });
    app.route("/", createJuniorApi());
    return app;
  }

  // Store the model calls of one Conversation, each at its own time and with
  // its own cache usage.
  async function storeCalls(
    conversationId: string,
    calls: Array<{
      atMs: number;
      cacheRead: number;
      cacheWrite?: number;
      stopReason?: "stop" | "toolUse";
    }>,
  ) {
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      activityAtMs: calls.at(-1)!.atMs,
      nowMs: calls[0]!.atMs,
    });
    await getConversationEventStore().append(
      conversationId,
      calls.map((call) => {
        const message = reply(call.cacheRead, call.atMs);
        return {
          createdAtMs: call.atMs + 1_000,
          data: historyItemFromPiMessage(
            {
              ...message,
              model: MODEL_ID,
              stopReason: call.stopReason ?? "stop",
              usage: { ...message.usage, cacheWrite: call.cacheWrite ?? 0 },
            },
            contextProvenance,
          ),
        };
      }),
    );
  }

  async function savings(nowMs: number) {
    vi.setSystemTime(nowMs);
    const response = await createJuniorApi().request(
      "http://localhost/api/cache-warming/savings?days=7",
    );
    return cacheWarmingSavingsReportSchema.parse(await response.json());
  }

  async function refill(
    app: ReturnType<typeof authenticatedApi>,
    nowMs: number,
    method: "GET" | "POST" = "GET",
  ) {
    vi.setSystemTime(nowMs);
    const response = await app.request(
      "http://localhost/api/cache-warming/savings/refill",
      { method },
    );
    if (response.status === 403) return { status: 403 };
    return {
      status: response.status,
      refill: cacheWarmingSavingsRefillResponseSchema.parse(
        await response.json(),
      ).refill,
    };
  }

  it("replaces the days before live recording started with stored history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await resolveViewerUser(ADMIN);
    await resolveViewerUser(PERSON);
    await setUserAdminFromSql(getDb(), ADMIN, true);
    const admin = authenticatedApi(ADMIN);
    const person = authenticatedApi(PERSON);
    // The first idle period ends with a read of the cache 7 minutes later,
    // the second with a write, and the third within the cache TTL.
    await storeCalls("local:test:savings-refill-idle", [
      { atMs: DAY_1, cacheRead: 60_000 },
      { atMs: DAY_1 + 7 * MINUTE, cacheRead: 60_000 },
      { atMs: DAY_1 + 14 * MINUTE, cacheRead: 0, cacheWrite: 60_000 },
      { atMs: DAY_1 + 18 * MINUTE, cacheRead: 60_000 },
    ]);
    // Two 7 minute tool waits: the first reads the cache, the second writes.
    const RUN = DAY_1 + 2 * 60 * MINUTE;
    await storeCalls("local:test:savings-refill-tools", [
      { atMs: RUN, cacheRead: 60_000, stopReason: "toolUse" },
      { atMs: RUN + 7 * MINUTE, cacheRead: 60_000, stopReason: "toolUse" },
      { atMs: RUN + 14 * MINUTE, cacheRead: 0, cacheWrite: 60_000 },
    ]);
    // Live recording already wrote the next day, so its history is left out.
    await storeCalls("local:test:savings-refill-live-day", [
      { atMs: DAY_2, cacheRead: 60_000 },
      { atMs: DAY_2 + 7 * MINUTE, cacheRead: 60_000 },
    ]);
    // Conversations with no model calls make the scan take two slices.
    for (let index = 0; index < 10; index += 1) {
      await getConversationStore().recordActivity({
        conversationId: `local:test:savings-refill-empty-${index}`,
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        activityAtMs: DAY_1,
        nowMs: DAY_1,
      });
    }
    vi.setSystemTime(DAY_2 + 10 * MINUTE);
    await recordWarmupCost(MODEL_ID, 0.05);
    const nowMs = DAY_2 + 26 * 60 * MINUTE;
    const before = await savings(nowMs);

    // A re-fill replaces counters that everyone sees.
    expect(await refill(person, nowMs, "POST")).toEqual({ status: 403 });
    expect(await refill(person, nowMs)).toEqual({ status: 403 });
    expect(await refill(admin, nowMs)).toEqual({
      status: 200,
      refill: { status: "idle" },
    });

    // The start request stores the job. Slices run later.
    expect(await refill(admin, nowMs, "POST")).toMatchObject({
      status: 202,
      refill: { status: "pending", totalConversations: 13 },
    });
    expect(await savings(nowMs)).toEqual(before);
    await runSavingsRefillSlice({ nowMs, budgetMs: 0 });
    expect(await refill(admin, nowMs, "POST")).toMatchObject({
      status: 409,
      refill: {
        status: "running",
        scannedConversations: 10,
        totalConversations: 13,
      },
    });

    await heartbeat(nowMs + MINUTE);
    expect((await refill(admin, nowMs + MINUTE)).refill).toMatchObject({
      status: "done",
      finishedAt: new Date(nowMs + MINUTE).toISOString(),
      scannedConversations: 13,
    });
    const report = await savings(nowMs + MINUTE);
    const { cost } = resolveGatewayModel(MODEL_ID);
    const read = (60_000 * cost.cacheRead) / 1_000_000;
    const write = (60_000 * cost.cacheWrite) / 1_000_000;
    const close = (usd: number) => expect.closeTo(usd, 3);
    // Two idle periods and two tool waits, each with one hit.
    expect(report.days.at(-3)).toMatchObject({
      date: "2031-07-01",
      idlePeriods: 4,
      hits: 2,
      savedUsd: close(2 * (write - read)),
      // History has no warmup calls, so the cost is unknown.
      warmupCostUsd: 0,
      netSavingsUsd: null,
      oracleSavingsUsd: close(4 * (write - 2 * read)),
      unwarmedIdlePeriods: 0,
    });
    expect(report.days.at(-2)).toMatchObject({
      date: "2031-07-02",
      idlePeriods: 0,
      warmupCostUsd: close(0.05),
      netSavingsUsd: close(-0.05),
    });
    expect(report.totals).toMatchObject({
      netSavingsUsd: close(-0.05),
      effectiveness: null,
      unknownCostDays: 1,
    });

    // A second re-fill replaces the days, so it adds nothing.
    expect((await refill(admin, nowMs + 2 * MINUTE, "POST")).status).toBe(202);
    await heartbeat(nowMs + 3 * MINUTE);
    await heartbeat(nowMs + 4 * MINUTE);
    expect(await savings(nowMs + 4 * MINUTE)).toEqual(report);

    // A job with no slice for the lease time stopped, and can start again.
    expect((await refill(admin, nowMs + 5 * MINUTE, "POST")).status).toBe(202);
    expect((await refill(admin, nowMs + 16 * MINUTE)).refill).toMatchObject({
      status: "failed",
      error: "The re-fill stopped before it finished.",
    });
    expect((await refill(admin, nowMs + 16 * MINUTE, "POST")).status).toBe(202);
    await heartbeat(nowMs + 17 * MINUTE);
    await heartbeat(nowMs + 18 * MINUTE);
    expect((await refill(admin, nowMs + 18 * MINUTE)).refill).toMatchObject({
      status: "done",
    });
    expect(await savings(nowMs + 18 * MINUTE)).toEqual(report);
  });

  it("finishes a re-fill with no day before live recording", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await resolveViewerUser(ADMIN);
    await setUserAdminFromSql(getDb(), ADMIN, true);
    const admin = authenticatedApi(ADMIN);
    await storeCalls("local:test:savings-refill-all-live", [
      { atMs: DAY_2, cacheRead: 60_000 },
      { atMs: DAY_2 + 7 * MINUTE, cacheRead: 60_000 },
    ]);
    const nowMs = DAY_2 + 26 * 60 * MINUTE;
    // Live recording covers every day of the 90-day window.
    vi.setSystemTime(nowMs - 90 * 24 * 60 * MINUTE);
    await recordWarmupCost(MODEL_ID, 0.05);
    const before = await savings(nowMs);

    expect((await refill(admin, nowMs, "POST")).status).toBe(202);
    await heartbeat(nowMs + MINUTE);
    expect((await refill(admin, nowMs + MINUTE)).refill).toMatchObject({
      status: "done",
    });
    expect(await savings(nowMs + MINUTE)).toEqual(before);
  });
});
