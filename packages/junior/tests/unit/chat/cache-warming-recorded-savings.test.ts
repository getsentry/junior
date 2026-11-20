import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import type { CacheWarmupMessage } from "@/chat/cache-warming/queue";
import { createJuniorApi } from "@/api";
import {
  cacheWarmingHourlyReportSchema,
  cacheWarmingSavingsReportSchema,
} from "@/api/schema";
import { WARMUP_MARGIN_MS } from "@/chat/cache-warming/model";
import { expectSqlBudget } from "../../fixtures/sql-budget";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { resolveGatewayModel } from "@/chat/pi/client";
import { getStateAdapter } from "@/chat/state/adapter";
import { mockTitleModel } from "../../fixtures/title-model";

const mocks = vi.hoisted(() => ({
  sendCacheWarmup: vi.fn(async (_message: unknown, _delayMs: number) => {}),
}));

vi.mock("@/chat/cache-warming/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/queue")>()),
  sendCacheWarmup: mocks.sendCacheWarmup,
}));

const { createCacheWarmingRecorder, runCacheWarmup } =
  await import("@/chat/cache-warming/warmup");

const MINUTE = 60_000;
const conversationId = "local:test:cache-warming-recorded-savings";
const model = resolveGatewayModel("anthropic/claude-opus-5.5");
const context: Context = {
  systemPrompt: "Answer the person.",
  messages: [{ role: "user", content: "Hi.", timestamp: 1 }],
};
const finalReply: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  api: "anthropic-messages",
  provider: "vercel-ai-gateway",
  model: model.id,
  usage: {
    input: 10,
    output: 10,
    cacheRead: 60_000,
    cacheWrite: 0,
    totalTokens: 60_020,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

const definitionsKey = { platform: "local", mode: "conversation" } as const;

// The recorder input of a person's Turn in a root Conversation.
function turnOf(userActor: boolean) {
  return {
    userActor,
    idleNeedsPendingWork: turnBehavior({ kind: "root", personInput: userActor })
      .idleNeedsPendingWork,
  };
}

type WarmupMessage = Extract<CacheWarmupMessage, { kind: "warmup" }>;

function scheduledWarmup(): WarmupMessage {
  const message = mocks.sendCacheWarmup.mock.calls
    .map(([sent]) => sent as CacheWarmupMessage)
    .reverse()
    .find((sent): sent is WarmupMessage => sent.kind === "warmup");
  if (!message) throw new Error("No warmup was scheduled.");
  return message;
}

describe("cache warming recorded savings", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await getStateAdapter().delete(
      `junior:cache_warming:conversation:${conversationId}`,
    );
  });

  it("counts the savings of each idle period that a call ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A day of its own, so the idle periods of the other cases do not count.
    vi.setSystemTime(new Date("2031-03-01T12:00:00.000Z"));
    const state = getStateAdapter();
    // The first idle period and the later ones are in different segments.
    const segments = ["user:1:none", "user:2-3:none"];
    for (const segment of segments) {
      for (let i = 0; i < 20; i++) {
        await state.appendToList(
          `junior:cache_warming:gaps:${segment}`,
          8 * MINUTE,
        );
      }
    }
    mockTitleModel("", { cacheReadTokens: 60_000 });
    const minutesLater = (minutes: number) =>
      vi.setSystemTime(Date.now() + minutes * MINUTE);
    const endTurnWith = async (cacheRead: number, turnContext = context) => {
      const recorder = createCacheWarmingRecorder(
        conversationId,
        turnOf(true),
        definitionsKey,
      );
      void recorder.wrap((() => undefined) as never)(model, turnContext, {});
      await recorder.record({
        ...finalReply,
        usage: {
          ...finalReply.usage,
          cacheRead,
          cacheWrite: 60_000 - cacheRead,
        },
      });
      await recorder.stop();
    };
    try {
      const startedAtMs = Date.now();
      await endTurnWith(60_000);
      const warmup = scheduledWarmup();
      vi.setSystemTime(warmup.cacheExpiresAtMs - WARMUP_MARGIN_MS);
      await runCacheWarmup(warmup);
      // The warmed cache still holds the prefix when the person returns.
      vi.setSystemTime(startedAtMs + 7 * MINUTE);
      await endTurnWith(60_000);
      // A warmup refreshed the cache, but the return still wrote it.
      const second = scheduledWarmup();
      vi.setSystemTime(second.cacheExpiresAtMs - WARMUP_MARGIN_MS);
      await runCacheWarmup(second);
      vi.setSystemTime(startedAtMs + 14 * MINUTE);
      await endTurnWith(0);
      // The cache lives through a return within its TTL without warmups.
      minutesLater(4);
      // Random text does not compress, so its snapshot is too large to store.
      await endTurnWith(60_000, {
        ...context,
        messages: [
          {
            role: "user",
            content: randomBytes(2 * 1024 * 1024).toString("base64"),
            timestamp: 1,
          },
        ],
      });
      minutesLater(7);
      await endTurnWith(0);

      const response = await createJuniorApi().request(
        "http://localhost/api/cache-warming/savings?days=1",
      );
      const { totals } = cacheWarmingSavingsReportSchema.parse(
        await response.json(),
      );
      // Prices are per million tokens. Each counted gap needs one warmup.
      const read = (60_000 * model.cost.cacheRead) / 1_000_000;
      const write = (60_000 * model.cost.cacheWrite) / 1_000_000;
      const close = (usd: number) => expect.closeTo(usd, 3);
      const daily = {
        idlePeriods: 3,
        hits: 1,
        savedUsd: close(write - read),
        warmupCostUsd: close(2 * read),
        oracleSavingsUsd: close(3 * (write - 2 * read)),
        unwarmedIdlePeriods: 1,
        unwarmedOracleSavingsUsd: close(write - 2 * read),
      };
      // The same counters, and the prompt cache of each call, per hour.
      const hourly = cacheWarmingHourlyReportSchema.parse(
        await (
          await createJuniorApi().request(
            "http://localhost/api/cache-warming/hourly?start=2031-03-01T12:00:00Z&end=2031-03-01T13:00:00Z",
          )
        ).json(),
      );
      expect(hourly.hours.map((hour) => hour.hour)).toEqual([
        "2031-03-01T12:00:00.000Z",
      ]);
      expect(totals).toMatchObject(daily);
      expect(hourly.totals.savings).toMatchObject(daily);
      // The two returns that read nothing wrote the whole prefix again.
      expect(hourly.totals.modelCache).toEqual({
        calls: 5,
        fullRewrites: 2,
        inputTokens: 5 * 60_010,
        cacheWriteTokens: 120_000,
        cacheReadTokens: 180_000,
        writeShare: close(120_000 / (5 * 60_010)),
        fullRewriteRate: close(2 / 5),
      });
      expect(hourly.totals.warmups).toEqual({
        sent: 2,
        missed: 0,
        warmedRewrites: 1,
        skipped: 0,
        sentByTurnEnding: { reply: 2 },
        skipReasons: {},
      });
    } finally {
      for (const segment of segments) {
        await state.delete(`junior:cache_warming:gaps:${segment}`);
      }
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  });
  it("writes the prompt cache of a failed run once, when it stops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-03-02T12:00:00.000Z"));
    const modelCache = async () =>
      cacheWarmingHourlyReportSchema.parse(
        await (
          await createJuniorApi().request(
            "http://localhost/api/cache-warming/hourly?start=2031-03-02T12:00:00Z&end=2031-03-02T13:00:00Z",
          )
        ).json(),
      ).totals.modelCache;
    const recorder = createCacheWarmingRecorder(
      conversationId,
      turnOf(true),
      definitionsKey,
    );
    const call = async (cacheRead: number) => {
      void recorder.wrap((() => undefined) as never)(model, context, {});
      await recorder.record({
        ...finalReply,
        stopReason: "toolUse",
        usage: {
          ...finalReply.usage,
          cacheRead,
          cacheWrite: 60_000 - cacheRead,
        },
      });
    };
    await call(0);
    await call(60_000);
    expect((await modelCache()).calls).toBe(0);
    // The run fails before its final response. The agent stops the recorder
    // in a finally block, which writes both calls in one statement.
    await expectSqlBudget(() => recorder.stop(), {
      statements: 1,
      serialRounds: 1,
    });
    expect(await modelCache()).toMatchObject({ calls: 2, fullRewrites: 1 });
  });
});
