import { describe, expect, it } from "vitest";
import { lookupSlackUser } from "@/chat/slack/user";
import { usersInfoOk } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

describe("lookupSlackUser", () => {
  it("uses the real name instead of the custom Slack display name", async () => {
    resetSlackApiMockState();
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({
        userId: "U039RR91S",
        userName: "david",
        displayName: "immutable dcramer",
        realName: "David Cramer",
        email: "david@example.com",
      }),
    });

    await expect(
      lookupSlackUser("T-DISPLAY-NAME", "U039RR91S"),
    ).resolves.toMatchObject({
      email: "david@example.com",
      fullName: "David Cramer",
      userName: "david",
    });
  });

  it("caches Slack profiles by workspace and user id", async () => {
    resetSlackApiMockState();
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({
        userId: "U123",
        userName: "workspace-one-user",
        displayName: "Workspace One User",
        realName: "Workspace One User",
        email: "one@example.com",
      }),
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({
        userId: "U123",
        userName: "workspace-two-user",
        displayName: "Workspace Two User",
        realName: "Workspace Two User",
        email: "two@example.com",
      }),
    });

    await expect(lookupSlackUser("T111", "U123")).resolves.toMatchObject({
      email: "one@example.com",
      fullName: "Workspace One User",
      userName: "workspace-one-user",
    });
    await expect(lookupSlackUser("T222", "U123")).resolves.toMatchObject({
      email: "two@example.com",
      fullName: "Workspace Two User",
      userName: "workspace-two-user",
    });
    await expect(lookupSlackUser("T111", "U123")).resolves.toMatchObject({
      email: "one@example.com",
      fullName: "Workspace One User",
      userName: "workspace-one-user",
    });

    expect(getCapturedSlackApiCalls("users.info")).toHaveLength(2);
  });
});
