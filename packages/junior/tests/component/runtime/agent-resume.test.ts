import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { createResumeState } from "@/chat/agent/resume";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import { BudgetExceededError } from "@/chat/services/budgets";
import { loadTurnSessionRecord } from "@/chat/services/turn-session-record";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";

const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;

describe("agent resume", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    if (originalStateAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalStateAdapter;
    }
  });

  it("keeps auth parking failures terminal", async () => {
    const conversationId = "local:test:auth-park-failure";
    const turnId = "turn-auth-park-failure";
    const destination = { platform: "local" as const, conversationId };
    const resume = createResumeState({
      destination,
      durability: {},
      getLoadedSkillNames: () => [],
      getModelId: () => "test/model",
      getReasoningLevel: () => undefined,
      recordActiveMcpProviders: async () => {
        throw new Error("provider metadata unavailable");
      },
      runSource: createLocalSource(conversationId),
      conversationId,
      turnId,
      sessionRecordState: await loadTurnSessionRecord({
        conversationId,
        sessionId: turnId,
      }),
      startedAtMs: Date.now(),
      surface: "internal",
    });

    await expect(
      resume.parkForAuth(
        new AuthorizationPauseError("mcp", "example", "Example", "link_sent"),
      ),
    ).rejects.toEqual(expect.any(Error));
    await expect(
      getAgentTurnSessionRecord(conversationId, turnId),
    ).resolves.toBeUndefined();
  });

  it("limits model steps and cumulative runtime for one turn", async () => {
    const conversationId = "local:test:turn-limits";
    const turnId = "turn-limits";
    const destination = { platform: "local" as const, conversationId };
    const base = {
      destination,
      durability: {},
      getLoadedSkillNames: () => [],
      getModelId: () => "test/model",
      getReasoningLevel: () => undefined,
      recordActiveMcpProviders: async () => {},
      runSource: createLocalSource(conversationId),
      conversationId,
      turnId,
      sessionRecordState: await loadTurnSessionRecord({
        conversationId,
        sessionId: turnId,
      }),
      surface: "internal" as const,
    };
    const steps = createResumeState({
      ...base,
      startedAtMs: Date.now(),
      turnBudgets: { turn_runtime: 60_000, turn_steps: 1 },
    });

    await expect(steps.startStep()).resolves.toBeUndefined();
    await expect(steps.startStep()).rejects.toMatchObject({
      budget: { name: "turn_steps", outcome: "stop" },
    });

    const runtime = createResumeState({
      ...base,
      startedAtMs: Date.now() - 1_000,
      turnBudgets: { turn_runtime: 500, turn_steps: 10 },
    });
    await expect(runtime.startStep()).rejects.toMatchObject({
      budget: { name: "turn_runtime", outcome: "stop" },
    });
  });

  it("keeps the step count across resumed history replacements", async () => {
    const conversationId = "local:test:durable-step-limit";
    const turnId = "turn-durable-step-limit";
    await upsertAgentTurnSessionRecord({
      conversationId,
      modelId: "test/model",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
          timestamp: 1,
        },
      ],
      resumeReason: "yield",
      sessionId: turnId,
      sliceId: 2,
      state: "awaiting_resume",
      stepCount: 1,
    });
    const resume = createResumeState({
      conversationId,
      destination: { platform: "local", conversationId },
      durability: {},
      getLoadedSkillNames: () => [],
      getModelId: () => "test/model",
      getReasoningLevel: () => undefined,
      recordActiveMcpProviders: async () => {},
      runSource: createLocalSource(conversationId),
      sessionRecordState: await loadTurnSessionRecord({
        conversationId,
        sessionId: turnId,
      }),
      startedAtMs: Date.now(),
      surface: "internal",
      turnId,
      turnBudgets: { turn_runtime: 60_000, turn_steps: 1 },
    });

    await expect(resume.startStep()).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });
});
