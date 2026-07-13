import { describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationExecutionProfile } from "@/chat/conversations/execution-profile";
import { createConversationRuntime } from "@/chat/runtime/conversation-runtime";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const CONVERSATION_ID = "local:test:conversation-runtime";

const PROFILE: ConversationExecutionProfile = {
  schemaVersion: 1,
  modelProfile: "coding",
  reasoning: { mode: "fixed", level: "high" },
  instructions: ["Focus on implementation evidence."],
  toolPolicy: { mode: "allowlist", toolNames: ["bash", "read"] },
};

const CHANGED_DEFAULT: ConversationExecutionProfile = {
  schemaVersion: 1,
  modelProfile: "standard",
  reasoning: { mode: "adaptive" },
  instructions: [],
  toolPolicy: { mode: "host" },
};

describe("conversation runtime", () => {
  it("materializes one durable profile and reuses it across hosts", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const profileStore = createSqlStore(fixture.sql);
      await profileStore.recordActivity({
        conversationId: CONVERSATION_ID,
        source: "local",
        nowMs: 1_000,
      });
      const run = vi.fn<AgentRunner["run"]>(async () =>
        completedAgentRun({
          text: "done",
          diagnostics: {
            assistantMessageCount: 1,
            modelId: "fake-model",
            outcome: "success",
            toolCalls: [],
            toolErrorCount: 0,
            toolResultCount: 0,
            usedPrimaryText: true,
          },
        }),
      );
      const request = {
        input: { messageText: "Implement it" },
        policy: {
          instructions: ["Respect the host boundary."],
          toolPolicy: {
            mode: "allowlist" as const,
            toolNames: ["read", "write"],
          },
        },
        routing: {
          destination: {
            platform: "local" as const,
            conversationId: CONVERSATION_ID,
          },
          source: createLocalSource(CONVERSATION_ID),
          correlation: { conversationId: CONVERSATION_ID },
        },
      };

      await createConversationRuntime({
        agentRunner: { run },
        defaultProfile: PROFILE,
        profileStore,
      }).run(request);
      await createConversationRuntime({
        agentRunner: { run },
        defaultProfile: CHANGED_DEFAULT,
        profileStore,
      }).run(request);

      expect(run).toHaveBeenCalledTimes(2);
      for (const [runtimeRequest] of run.mock.calls) {
        expect(runtimeRequest.policy).toMatchObject({
          modelProfile: "coding",
          reasoningPolicy: { mode: "fixed", level: "high" },
          instructions: [
            "Respect the host boundary.",
            "Focus on implementation evidence.",
          ],
          toolPolicy: {
            mode: "allowlist",
            toolNames: ["read"],
          },
        });
      }
      await expect(
        profileStore.getOrCreateExecutionProfile({
          conversationId: CONVERSATION_ID,
          profile: CHANGED_DEFAULT,
        }),
      ).resolves.toEqual(PROFILE);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a profile key that disagrees with local routing", async () => {
    const run = vi.fn<AgentRunner["run"]>();
    const runtime = createConversationRuntime({
      agentRunner: { run },
      defaultProfile: PROFILE,
      profileStore: {
        getOrCreateExecutionProfile: vi.fn(),
      },
    });

    await expect(
      runtime.run({
        input: { messageText: "Implement it" },
        routing: {
          destination: {
            platform: "local",
            conversationId: CONVERSATION_ID,
          },
          source: createLocalSource(CONVERSATION_ID),
          correlation: { conversationId: "local:test:other" },
        },
      }),
    ).rejects.toThrow("Local conversation routing identity does not match");
    expect(run).not.toHaveBeenCalled();
  });
});
