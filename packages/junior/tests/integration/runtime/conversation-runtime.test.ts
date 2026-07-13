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
  modelProfile: "coding",
  reasoning: { mode: "fixed", level: "high" },
  instructions: ["Focus on implementation evidence."],
  toolPolicy: { mode: "allowlist", toolNames: ["bash", "read"] },
};

const CHANGED_DEFAULT: ConversationExecutionProfile = {
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

      const [storedProfile] = await fixture.sql.query<{
        execution_allowed_tool_names: string[] | null;
        execution_instructions: string[];
        execution_model_profile: string | null;
        execution_reasoning_level: string | null;
      }>(
        `
SELECT
  execution_allowed_tool_names,
  execution_instructions,
  execution_model_profile,
  execution_reasoning_level
FROM junior_conversations
WHERE conversation_id = $1
`,
        [CONVERSATION_ID],
      );

      expect(run).toHaveBeenCalledTimes(2);
      expect(storedProfile).toEqual({
        execution_allowed_tool_names: ["bash", "read"],
        execution_instructions: ["Focus on implementation evidence."],
        execution_model_profile: "coding",
        execution_reasoning_level: "high",
      });
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

  it("stores null host tools separately from an empty allowlist", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const profileStore = createSqlStore(fixture.sql);
      const conversationId = "local:test:adaptive-profile";

      await expect(
        profileStore.getOrCreateExecutionProfile({
          conversationId,
          profile: CHANGED_DEFAULT,
        }),
      ).resolves.toEqual(CHANGED_DEFAULT);

      const [storedProfile] = await fixture.sql.query<{
        execution_allowed_tool_names: string[] | null;
        execution_instructions: string[];
        execution_model_profile: string | null;
        execution_reasoning_level: string | null;
      }>(
        `
SELECT
  execution_allowed_tool_names,
  execution_instructions,
  execution_model_profile,
  execution_reasoning_level
FROM junior_conversations
WHERE conversation_id = $1
`,
        [conversationId],
      );

      expect(storedProfile).toEqual({
        execution_allowed_tool_names: null,
        execution_instructions: [],
        execution_model_profile: "standard",
        execution_reasoning_level: null,
      });

      const noToolsConversationId = "local:test:no-tools-profile";
      const noToolsProfile: ConversationExecutionProfile = {
        ...CHANGED_DEFAULT,
        toolPolicy: { mode: "allowlist", toolNames: [] },
      };
      await expect(
        profileStore.getOrCreateExecutionProfile({
          conversationId: noToolsConversationId,
          profile: noToolsProfile,
        }),
      ).resolves.toEqual(noToolsProfile);

      const [storedNoToolsProfile] = await fixture.sql.query<{
        execution_allowed_tool_names: string[] | null;
      }>(
        `
SELECT execution_allowed_tool_names
FROM junior_conversations
WHERE conversation_id = $1
`,
        [noToolsConversationId],
      );
      expect(storedNoToolsProfile?.execution_allowed_tool_names).toEqual([]);

      await expect(
        profileStore.getOrCreateExecutionProfile({
          conversationId: noToolsConversationId,
          profile: CHANGED_DEFAULT,
        }),
      ).resolves.toEqual(noToolsProfile);
    } finally {
      await fixture.close();
    }
  });

  it("rejects malformed materialized profile columns", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const profileStore = createSqlStore(fixture.sql);
      const conversationId = "local:test:malformed-profile";
      await profileStore.getOrCreateExecutionProfile({
        conversationId,
        profile: PROFILE,
      });
      await fixture.sql.execute(
        `
UPDATE junior_conversations
SET execution_model_profile = ''
WHERE conversation_id = $1
`,
        [conversationId],
      );

      await expect(
        profileStore.getOrCreateExecutionProfile({
          conversationId,
          profile: CHANGED_DEFAULT,
        }),
      ).rejects.toThrow("Invalid string");
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
