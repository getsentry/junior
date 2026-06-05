import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/chat/config", () => ({
  getSlackBotToken: () => "test-token",
}));

import { lookupSlackResumeRequester } from "@/chat/slack/user";

function makeSlackResponse(overrides?: {
  email?: string | null; // null = explicitly omit email from profile
  name?: string;
  displayName?: string;
}) {
  const email =
    overrides === undefined
      ? "alice@sentry.io"
      : overrides.email === null
        ? undefined
        : (overrides.email ?? "alice@sentry.io");
  return {
    ok: true,
    user: {
      name: overrides?.name ?? "alice",
      real_name: "Alice Example",
      profile: {
        display_name: overrides?.displayName ?? "Alice Example",
        real_name: "Alice Example",
        ...(email !== undefined ? { email } : {}),
      },
    },
  };
}

function mockFetch(body: unknown, status = 200) {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  );
}

describe("lookupSlackResumeRequester", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses live profile when Slack lookup succeeds", async () => {
    mockFetch(makeSlackResponse());

    const result = await lookupSlackResumeRequester("UA001", {
      slackUserId: "UA001",
      slackUserName: "old-alice",
      fullName: "Old Alice",
      email: "old@sentry.io",
    });

    expect(result).toMatchObject({
      userId: "UA001",
      email: "alice@sentry.io",
      fullName: "Alice Example",
      userName: "alice",
    });
  });

  it("fills missing fields from stored session requester when Slack lookup returns null", async () => {
    mockFetch({ ok: false });

    const result = await lookupSlackResumeRequester("UA002", {
      slackUserId: "UA002",
      slackUserName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });

    expect(result).toMatchObject({
      userId: "UA002",
      userName: "alice",
      fullName: "Alice Example",
      email: "alice@sentry.io",
    });
  });

  it("live data wins for fields the live lookup provides; stored fills only gaps", async () => {
    // Live profile has fullName but no email (null = omit email from profile)
    mockFetch(makeSlackResponse({ email: null, displayName: "Live Alice" }));

    const result = await lookupSlackResumeRequester("UA003", {
      slackUserId: "UA003",
      slackUserName: "stored-alice",
      fullName: "Stored Alice",
      email: "stored@sentry.io",
    });

    expect(result.fullName).toBe("Live Alice");
    expect(result.email).toBe("stored@sentry.io");
  });

  it("does not use stored fields when stored slackUserId differs from resumed userId", async () => {
    mockFetch({ ok: false });

    const result = await lookupSlackResumeRequester("UA004", {
      slackUserId: "UBob",
      slackUserName: "bob",
      fullName: "Bob",
      email: "bob@sentry.io",
    });

    expect(result.userId).toBe("UA004");
    expect(result.email).toBeUndefined();
    expect(result.fullName).toBeUndefined();
    expect(result.userName).toBeUndefined();
  });

  it("does not use stored fields when stored has no slackUserId", async () => {
    mockFetch({ ok: false });

    const result = await lookupSlackResumeRequester("UA005", {
      // no slackUserId — ownership cannot be proven
      slackUserName: "alice",
      fullName: "Alice",
      email: "alice@sentry.io",
    });

    expect(result.userId).toBe("UA005");
    expect(result.email).toBeUndefined();
    expect(result.fullName).toBeUndefined();
  });

  it("works with no stored requester", async () => {
    mockFetch(makeSlackResponse());

    const result = await lookupSlackResumeRequester("UA006", undefined);

    expect(result).toMatchObject({
      userId: "UA006",
      email: "alice@sentry.io",
    });
  });
});
