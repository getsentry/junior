import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { requestPluginConnection } from "@/chat/plugins/connection-request";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const { getDefinition, startOAuthFlow } = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  startOAuthFlow: vi.fn(),
}));

vi.mock("@/chat/oauth-flow", () => ({ startOAuthFlow }));
vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: { getDefinition },
}));

const actor = { platform: "slack", teamId: "T123", userId: "U123" } as const;

function slackTurn(): ToolRuntimeContext {
  return {
    actor,
    conversationId: "slack:C123:1700000000.000000",
    destination: { platform: "slack", teamId: "T123", channelId: "C123" },
    egress: {} as never,
    source: createSlackSource({
      teamId: "T123",
      channelId: "C123",
      messageTs: "1700000000.000100",
      threadTs: "1700000000.000000",
      visibility: "public",
    }),
    workspace: {} as never,
  };
}

describe("requestPluginConnection", () => {
  beforeEach(() => {
    getDefinition.mockReset();
    getDefinition.mockReturnValue({
      manifest: { name: "github", oauth: { clientIdEnv: "ID" } },
    });
    startOAuthFlow.mockReset();
    startOAuthFlow.mockResolvedValue({ ok: true, delivery: "in_context" });
  });

  it("privately sends the Slack actor a link in the conversation thread", async () => {
    await expect(requestPluginConnection("github", slackTurn())).resolves.toBe(
      true,
    );

    expect(startOAuthFlow).toHaveBeenCalledWith("github", {
      actorId: "U123",
      actor,
      channelId: "C123",
      threadTs: "1700000000.000000",
      resumeConversationId: "slack:C123:1700000000.000000",
    });
  });

  it("sends no link outside a Slack message turn or for service-account-only plugins", async () => {
    const localTurn: ToolRuntimeContext = {
      conversationId: "local:test",
      destination: { platform: "local", conversationId: "local:test" },
      egress: {} as never,
      source: {
        kind: "local",
        visibility: "private",
        conversationId: "local:test",
      },
      workspace: {} as never,
    };
    await expect(requestPluginConnection("github", localTurn)).resolves.toBe(
      false,
    );

    getDefinition.mockReturnValue({
      manifest: {
        name: "github",
        oauth: { clientIdEnv: "ID" },
        accounts: { userOAuth: false },
      },
    });
    await expect(requestPluginConnection("github", slackTurn())).resolves.toBe(
      false,
    );

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });
});
