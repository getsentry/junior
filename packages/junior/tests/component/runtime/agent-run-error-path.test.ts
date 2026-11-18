import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import * as Sentry from "@/chat/sentry";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";

const originalAiModel = process.env["AI_MODEL"];

process.env["AI_MODEL"] = "openai/gpt-5.4";

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
  const sentEvents: Sentry.ErrorEvent[] = [];
  let client: ReturnType<typeof Sentry.init>;

  beforeAll(() => {
    client = Sentry.init({
      dsn: "https://public@example.com/1",
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, payload] of envelope[1]) {
            if (header.type === "event") {
              sentEvents.push(payload as Sentry.ErrorEvent);
            }
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
  });

  afterAll(async () => {
    await client?.close();
    if (originalAiModel === undefined) {
      delete process.env["AI_MODEL"];
    } else {
      process.env["AI_MODEL"] = originalAiModel;
    }
  });

  it("preserves sandbox dependency hash on non-retryable failures", async () => {
    const outcome = await executeAgentRun({
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId: "turn-sandbox-failure",
      instruction: { text: "hello" },
      destination: LOCAL_DESTINATION,
      source: LOCAL_SOURCE,
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
    expect(reply!.diagnostics.reasoningLevel).toBe("high");
  });

  it("reports a startup failure once, with request context", async () => {
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => records.push(record));
    sentEvents.length = 0;

    let outcome: AgentRunOutcome;
    try {
      outcome = await executeAgentRun({
        conversationId: LOCAL_DESTINATION.conversationId,
        turnId: "turn-context-failure",
        runId: "run-context-failure",
        instruction: { text: "hello" },
        actor: {
          platform: "local",
          userId: "local-user",
          userName: "alice",
        },
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
      });
    } finally {
      unregister();
    }

    const failure = records.find(
      (record) => record.eventName === "agent.turn.provider_error",
    );
    expect(failure?.attributes).toMatchObject({
      "app.platform": "local",
      "app.run.id": "run-context-failure",
      "user.id": "local-user",
      "user.name": "alice",
      "gen_ai.conversation.id": LOCAL_DESTINATION.conversationId,
      "messaging.destination.name": LOCAL_DESTINATION.conversationId,
      "messaging.message.conversation_id": LOCAL_DESTINATION.conversationId,
      "messaging.system": "local",
    });

    // The run reports its own failure. The failure reply shows that event,
    // and nothing reports the failure again.
    const result = outcome.status === "completed" ? outcome.result : undefined;
    const finalized = finalizeFailedTurnReplyWithEvent({ reply: result! });
    await client?.flush();
    const eventId = result!.diagnostics.eventId;
    expect(eventId).toBeDefined();
    expect(sentEvents.map((event) => event.event_id)).toEqual([eventId]);
    expect(sentEvents[0]?.extra).toMatchObject({
      "app.ai.failure_reason": "unknown",
      "app.ai.outcome": "provider_error",
    });
    expect(finalized.reply.text).toContain(`event_id=${eventId}`);
  });

  it("preserves configured reasoning in failure diagnostics", async () => {
    const outcome = await executeAgentRun({
      conversationId: LOCAL_DESTINATION.conversationId,
      turnId: "turn-reasoning-failure",
      instruction: { text: "hello" },
      reasoning: "low",
      destination: LOCAL_DESTINATION,
      source: LOCAL_SOURCE,
    });
    const reply = outcome.status === "completed" ? outcome.result : undefined;

    expect(reply).toBeDefined();
    expect(reply!.diagnostics.outcome).toBe("provider_error");
    expect(reply!.diagnostics.reasoningLevel).toBe("low");
  });

  it("propagates pre-commit failures when durable input commit is required", async () => {
    await expect(
      executeAgentRun({
        conversationId: LOCAL_DESTINATION.conversationId,
        turnId: "turn-input-failure",
        instruction: { text: "hello" },
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
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
        instruction: { text: "hello" },
      } as Parameters<typeof executeAgentRun>[0]),
    ).rejects.toThrow("Assistant reply generation requires a destination");
  });

  it("hard-fails Actor platform and Source kind mismatches", async () => {
    await expect(
      executeAgentRun({
        conversationId: LOCAL_DESTINATION.conversationId,
        turnId: "turn-actor-mismatch",
        instruction: { text: "hello" },
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
        },
      }),
    ).rejects.toThrow(
      'Actor platform "slack" does not match Source kind "local"',
    );
  });

  it("hard-fails conflicting local conversation identities", async () => {
    await expect(
      executeAgentRun({
        conversationId: "local:test:different-conversation",
        turnId: "turn-conversation-mismatch",
        instruction: { text: "hello" },
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
      }),
    ).rejects.toThrow(
      "Source, destination, and run conversation IDs do not match",
    );
  });
});
