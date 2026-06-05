import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/chat/config", () => ({
  getSlackBotToken: () => "test-token",
}));

import { resolveSlackResumeRequester } from "@/chat/slack/user";

function makeSlackApiResponse(overrides?: {
  email?: string | null; // null = omit email from profile
  name?: string;
  displayName?: string;
}) {
  const email =
    overrides === undefined
      ? "live@sentry.io"
      : overrides.email === null
        ? undefined
        : (overrides.email ?? "live@sentry.io");
  return {
    ok: true,
    user: {
      name: overrides?.name ?? "live-alice",
      real_name: "Live Alice",
      profile: {
        display_name: overrides?.displayName ?? "Live Alice",
        real_name: "Live Alice",
        ...(email !== undefined ? { email } : {}),
      },
    },
  };
}

describe("resolveSlackResumeRequester", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses stored session requester directly without calling Slack when slackUserId matches", async () => {
    // Stored has full identity from the initial turn.
    const result = await resolveSlackResumeRequester("U100", {
      slackUserId: "U100",
      slackUserName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });

    // Slack API must not be called — stored identity is complete and proven.
    expect(fetch).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      userId: "U100",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });
  });

  it("uses stored even when only some display fields are present", async () => {
    const result = await resolveSlackResumeRequester("U101", {
      slackUserId: "U101",
      slackUserName: "alice",
      // no fullName or email — partial stored is still used, no live call
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.userId).toBe("U101");
    expect(result.userName).toBe("alice");
    expect(result.email).toBeUndefined();
    expect(result.fullName).toBeUndefined();
  });

  it("falls back to live Slack lookup when no stored requester is available", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeSlackApiResponse()), { status: 200 }),
    );

    const result = await resolveSlackResumeRequester("U200", undefined);

    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      userId: "U200",
      email: "live@sentry.io",
      fullName: "Live Alice",
      userName: "live-alice",
    });
  });

  it("falls back to live Slack lookup when stored slackUserId does not match", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeSlackApiResponse()), { status: 200 }),
    );

    const result = await resolveSlackResumeRequester("UAlice", {
      slackUserId: "UBob",
      slackUserName: "bob",
      fullName: "Bob",
      email: "bob@sentry.io",
    });

    // Live lookup called for UAlice, not Bob's stored identity.
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.userId).toBe("UAlice");
    expect(result.email).toBe("live@sentry.io");
    expect(result.email).not.toBe("bob@sentry.io");
    expect(result.fullName).not.toBe("Bob");
  });

  it("falls back to live Slack lookup when stored has no slackUserId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeSlackApiResponse()), { status: 200 }),
    );

    // Stored without slackUserId — ownership cannot be proven.
    const result = await resolveSlackResumeRequester("U300", {
      slackUserName: "alice",
      fullName: "Alice",
      email: "alice@sentry.io",
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(result.userId).toBe("U300");
  });
});
