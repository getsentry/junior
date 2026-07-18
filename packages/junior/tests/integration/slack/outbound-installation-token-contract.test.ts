import type { SlackAdapter } from "@chat-adapter/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithSlackInstallationToken } from "@/chat/slack/client";
import {
  createSlackDeliveryLocator,
  postSlackMessage,
} from "@/chat/slack/outbound";
import { createInstallationBoundRecoverableSlackDeliveryPort } from "@/chat/app/services";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

describe("Slack contract: outbound installation token", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
    resetSlackApiMockState();
  });

  it("posts with the ambient destination installation token when bound", async () => {
    await runWithSlackInstallationToken(
      "xoxb-destination-workspace-token",
      () =>
        postSlackMessage({
          channelId: "slack:C123",
          text: "hello from another workspace",
        }),
    );

    const calls = getCapturedSlackApiCalls("chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe(
      "Bearer xoxb-destination-workspace-token",
    );
  });

  it("posts with the env bot token when no installation token is bound", async () => {
    await postSlackMessage({
      channelId: "slack:C123",
      text: "hello from the default workspace",
    });

    const calls = getCapturedSlackApiCalls("chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe("Bearer xoxb-test-token");
  });

  it("binds recoverable post and reconciliation to the persisted workspace", async () => {
    const resolveTokenForTeam = vi.fn(async (teamId: string) => ({
      botUserId: "UDEST",
      token: `xoxb-${teamId}`,
    }));
    const adapter = {
      initialize: vi.fn(async () => undefined),
      requestContext: {
        run: async (_context: unknown, task: () => Promise<unknown>) =>
          await task(),
      },
      resolveTokenForTeam,
    } as unknown as SlackAdapter;
    const port = createInstallationBoundRecoverableSlackDeliveryPort({
      getSlackAdapter: () => adapter,
    });
    const metadata = { locator: createSlackDeliveryLocator(), partIndex: 0 };

    await expect(
      port.post({
        channelId: "C123",
        metadata,
        teamId: "TDEST",
        text: "recover in the destination workspace",
        threadTs: "1718123456.000000",
      }),
    ).resolves.toMatchObject({ outcome: "accepted" });
    await expect(
      port.reconcile({
        channelId: "C123",
        metadata,
        oldestTs: "1718123400.000000",
        teamId: "TDEST",
        threadTs: "1718123456.000000",
      }),
    ).resolves.toEqual({ outcome: "confirmed_absent" });

    expect(resolveTokenForTeam).toHaveBeenCalledTimes(2);
    expect(resolveTokenForTeam).toHaveBeenNthCalledWith(1, "TDEST", undefined);
    expect(resolveTokenForTeam).toHaveBeenNthCalledWith(2, "TDEST", undefined);
    const providerCalls = [
      ...getCapturedSlackApiCalls("chat.postMessage"),
      ...getCapturedSlackApiCalls("auth.test"),
      ...getCapturedSlackApiCalls("conversations.replies"),
    ];
    expect(providerCalls).toHaveLength(3);
    expect(providerCalls.map((call) => call.headers.authorization)).toEqual([
      "Bearer xoxb-TDEST",
      "Bearer xoxb-TDEST",
      "Bearer xoxb-TDEST",
    ]);
  });
});
