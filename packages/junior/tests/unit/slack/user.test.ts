import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/chat/config", () => ({
  getSlackBotToken: () => "test-token",
}));

import { resolveSlackResumeRequester } from "@/chat/slack/user";

function makeSlackApiResponse() {
  return {
    ok: true,
    user: {
      name: "live-alice",
      real_name: "Live Alice",
      profile: {
        display_name: "Live Alice",
        real_name: "Live Alice",
        email: "live@sentry.io",
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

  it("uses stored session requester directly without calling Slack", async () => {
    const result = await resolveSlackResumeRequester("U100", {
      slackUserName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });

    // The stored and resumed user ids are always the same value — no Slack call needed.
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      userId: "U100",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });
  });

  it("uses stored even when only some display fields are present — still no Slack call", async () => {
    const result = await resolveSlackResumeRequester("U101", {
      slackUserName: "alice",
      // no fullName or email
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.userId).toBe("U101");
    expect(result.userName).toBe("alice");
    expect(result.email).toBeUndefined();
  });

  it("falls back to live Slack lookup only when stored requester is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeSlackApiResponse()), { status: 200 }),
    );

    const result = await resolveSlackResumeRequester("U200", undefined);

    // Live lookup only fires for old session records that predate requester storage.
    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      userId: "U200",
      email: "live@sentry.io",
      fullName: "Live Alice",
      userName: "live-alice",
    });
  });
});
