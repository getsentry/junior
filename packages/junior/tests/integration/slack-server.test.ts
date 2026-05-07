import { describe, expect, it } from "vitest";

describe("Slack MSW server", () => {
  it("fails on unhandled Slack host requests", async () => {
    const response = await fetch("https://slack.com/does-not-exist");
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { message?: string };
    expect(payload.message).toContain(
      "[MSW] Unhandled mocked request: GET https://slack.com/does-not-exist",
    );
  });

  it("returns default mock responses for supported Slack API methods", async () => {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        channel: "C_TEST",
        text: "hello",
      }).toString(),
    });

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { ok?: boolean; ts?: string };
    expect(payload.ok).toBe(true);
    expect(payload.ts).toBe("1700000000.100");
  });

  it("rejects adapter-scoped Slack conversation ids", async () => {
    const response = await fetch(
      "https://slack.com/api/assistant.threads.setStatus",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          channel_id: "slack:D_TEST",
          thread_ts: "1700000000.100",
          status: "Thinking …",
        }).toString(),
      },
    );

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      detail?: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("channel_not_found");
    expect(payload.detail).toBe("Invalid channel_id");
  });
});
