import { afterAll, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";

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
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId: "turn-sandbox-failure",
      input: { messageText: "hello" },
      routing: { destination: LOCAL_DESTINATION, source: LOCAL_SOURCE },
      state: {
        sandboxRef: {
          id: "sb-123",
          profileHash: "hash-abc",
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
    expect(reply!.sandboxRef).toEqual({
      id: "sb-123",
      profileHash: "hash-abc",
    });
    expect(reply!.diagnostics.outcome).toBe("provider_error");
    expect(reply!.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(reply!.diagnostics.reasoningLevel).toBeUndefined();
  });

  it("binds authoritative request context before startup failures", async () => {
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => records.push(record));

    try {
      await executeAgentRun({
        conversationId: LOCAL_DESTINATION.conversationId,
        turnId: "turn-context-failure",
        runId: "run-context-failure",
        input: { messageText: "hello" },
        routing: {
          actor: {
            platform: "local",
            userId: "local-user",
            userName: "alice",
          },
          destination: LOCAL_DESTINATION,
          source: LOCAL_SOURCE,
        },
      });
    } finally {
      unregister();
    }

    const failure = records.find(
      (record) => record.eventName === "assistant.reply.generation.failed",
    );
    expect(failure?.attributes).toMatchObject({
      "app.platform": "local",
      "app.run.id": "run-context-failure",
      "enduser.id": "local-user",
      "enduser.pseudo.id": "alice",
      "gen_ai.conversation.id": LOCAL_DESTINATION.conversationId,
      "messaging.destination.name": LOCAL_DESTINATION.conversationId,
      "messaging.message.conversation_id": LOCAL_DESTINATION.conversationId,
      "messaging.system": "local",
    });
  });

  it("preserves configured reasoning in failure diagnostics", async () => {
    const outcome = await executeAgentRun({
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId: "turn-reasoning-failure",
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
        conversationId: LOCAL_DESTINATION.conversationId,
        turnId: "turn-input-failure",
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
        conversationId: LOCAL_DESTINATION.conversationId,
        turnId: "turn-missing-destination",
        input: { messageText: "hello" },
        routing: {} as Parameters<typeof executeAgentRun>[0]["routing"],
      }),
    ).rejects.toThrow("Assistant reply generation requires a destination");
  });

  it("hard-fails actor and destination platform mismatches", async () => {
    await expect(
      executeAgentRun({
        conversationId: LOCAL_DESTINATION.conversationId,
        turnId: "turn-actor-mismatch",
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

  it("hard-fails conflicting local conversation identities", async () => {
    await expect(
      executeAgentRun({
        conversationId: "local:test:different-conversation",
        turnId: "turn-conversation-mismatch",
        input: { messageText: "hello" },
        routing: {
          destination: LOCAL_DESTINATION,
          source: LOCAL_SOURCE,
        },
      }),
    ).rejects.toThrow(
      "Source, destination, and run conversation IDs do not match",
    );
  });
});
