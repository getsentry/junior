import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSlackClient,
  runWithSlackInstallationToken,
  SlackActionError,
} from "@/chat/slack/client";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

const getSlackBotTokenMock = vi.hoisted(() =>
  vi.fn<() => string | undefined>(),
);

vi.mock("@/chat/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/config")>()),
  getSlackBotToken: () => getSlackBotTokenMock(),
}));

describe("getSlackClient token resolution", () => {
  beforeEach(() => {
    getSlackBotTokenMock.mockReset();
  });

  it("uses the ambient destination installation token over the env token", () => {
    getSlackBotTokenMock.mockReturnValue("xoxb-env-token");

    const token = runWithSlackInstallationToken(
      "xoxb-installation-token",
      () => getSlackClient().token,
    );

    expect(token).toBe("xoxb-installation-token");
  });

  it("falls back to the env token for single-workspace deployments", () => {
    getSlackBotTokenMock.mockReturnValue("xoxb-env-token");

    expect(getSlackClient().token).toBe("xoxb-env-token");
  });

  it("fails a workspace-scoped call when no installation token can be resolved", () => {
    getSlackBotTokenMock.mockReturnValue(undefined);

    runWithWorkspaceTeamId("T_OTHER_WORKSPACE", () => {
      let caught: unknown;
      try {
        getSlackClient();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SlackActionError);
      expect((caught as SlackActionError).code).toBe("missing_token");
      expect((caught as SlackActionError).message).toContain(
        "T_OTHER_WORKSPACE",
      );
    });
  });

  it("rejects binding an empty installation token", () => {
    expect(() => runWithSlackInstallationToken("   ", () => "ran")).toThrow(
      SlackActionError,
    );
  });
});
