import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";

const originalAiModel = process.env.AI_MODEL;

process.env.AI_MODEL = "openai/gpt-5.4";

vi.mock("@/chat/skills", () => ({
  discoverSkills: vi.fn(async () => {
    throw new Error("discover failed");
  }),
  findSkillByName: vi.fn(),
  parseSkillInvocation: vi.fn(),
}));

const { executeAgentRun } = await import("@/chat/agent");

const LOCAL_DESTINATION = {
  platform: "local" as const,
  conversationId: "local:test:respond-error-path",
};
const LOCAL_SOURCE = createLocalSource(LOCAL_DESTINATION.conversationId);
const SLACK_DESTINATION = {
  platform: "slack" as const,
  teamId: "T123",
  channelId: "C123",
};
const SLACK_SOURCE = createSlackSource({
  teamId: SLACK_DESTINATION.teamId,
  channelId: SLACK_DESTINATION.channelId,
  type: "priv",
});

describe("executeAgentRun error path", () => {
  afterAll(() => {
    if (originalAiModel === undefined) {
      delete process.env.AI_MODEL;
    } else {
      process.env.AI_MODEL = originalAiModel;
    }
  });

  it("preserves sandbox dependency hash on non-retryable failures", async () => {
    const outcome = await executeAgentRun({
      input: { messageText: "hello" },
      routing: { destination: LOCAL_DESTINATION, source: LOCAL_SOURCE },
      state: {
        sandbox: {
          sandboxId: "sb-123",
          sandboxDependencyProfileHash: "hash-abc",
        },
      },
    });
    const reply = outcome.status === "completed" ? outcome.result : undefined;
    expect(reply).toBeDefined();
    expect(reply!.diagnostics.outcome).toBe("provider_error");

    // Raw exception text stays in diagnostics; it is never reply text.
    expect(reply!.text).toBe("");
    expect(reply!.diagnostics.errorMessage).toBe("discover failed");
    expect(reply!.diagnostics.assistantMessageCount).toBe(0);
    expect(reply!.sandboxId).toBe("sb-123");
    expect(reply!.sandboxDependencyProfileHash).toBe("hash-abc");
    expect(reply!.diagnostics.outcome).toBe("provider_error");
    expect(reply!.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(reply!.diagnostics.reasoningLevel).toBeUndefined();
  });

  it("preserves configured reasoning in failure diagnostics", async () => {
    const outcome = await executeAgentRun({
      input: { messageText: "hello" },
      policy: { reasoningLevel: "high" },
      routing: { destination: LOCAL_DESTINATION, source: LOCAL_SOURCE },
    });
    const reply = outcome.status === "completed" ? outcome.result : undefined;

    expect(reply).toBeDefined();
    expect(reply!.diagnostics.outcome).toBe("provider_error");
    expect(reply!.diagnostics.reasoningLevel).toBe("high");
  });

  it("propagates pre-commit failures when durable input commit is required", async () => {
    await expect(
      executeAgentRun({
        input: { messageText: "hello" },
        routing: { destination: LOCAL_DESTINATION, source: LOCAL_SOURCE },
        durability: {
          onInputCommitted: async () => {
            throw new Error("input should not commit before startup succeeds");
          },
        },
      }),
    ).rejects.toThrow("discover failed");
  });

  it("hard-fails missing destinations", async () => {
    await expect(
      executeAgentRun({
        input: { messageText: "hello" },
        routing: {} as Parameters<typeof executeAgentRun>[0]["routing"],
      }),
    ).rejects.toThrow("Assistant reply generation requires a destination");
  });

  it("hard-fails actor and destination platform mismatches", async () => {
    await expect(
      executeAgentRun({
        input: { messageText: "hello" },
        routing: {
          destination: LOCAL_DESTINATION,
          source: LOCAL_SOURCE,
          actor: {
            platform: "slack",
            teamId: "T123",
            userId: "U123",
          },
        },
      }),
    ).rejects.toThrow(
      'Actor platform "slack" does not match destination platform "local"',
    );
  });

  it("hard-fails Slack correlation and destination mismatches", async () => {
    await expect(
      executeAgentRun({
        input: { messageText: "hello" },
        routing: {
          destination: SLACK_DESTINATION,
          source: SLACK_SOURCE,
          correlation: {
            channelId: "C999",
            teamId: "T123",
          },
        },
      }),
    ).rejects.toThrow(
      "Slack correlation channel does not match destination channel",
    );
  });
});
