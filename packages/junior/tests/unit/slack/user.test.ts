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
        userId: "U789",
        userName: "alice",
        displayName: "shipit alice",
        realName: "Alice Example",
        email: "alice@example.com",
      }),
    });

    await expect(
      lookupSlackUser("T-DISPLAY-NAME", "U789"),
    ).resolves.toMatchObject({
      email: "alice@example.com",
      fullName: "Alice Example",
      userName: "alice",
    });
  });

  it("accepts null optional Slack profile fields", async () => {
    resetSlackApiMockState();
    queueSlackApiResponse("users.info", {
      body: {
        ok: true,
        user: {
          name: null,
          profile: { email: null, real_name: null },
        },
      },
    });

    await expect(lookupSlackUser("T-NULLISH", "U789")).resolves.toEqual({});
  });

  it("rejects malformed Slack profile responses", async () => {
    resetSlackApiMockState();
    queueSlackApiResponse("users.info", {
      body: {
        ok: true,
        user: {
          name: "alice",
          profile: { real_name: 42 },
        },
      },
    });

    await expect(lookupSlackUser("T-MALFORMED", "U789")).resolves.toBeNull();
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
