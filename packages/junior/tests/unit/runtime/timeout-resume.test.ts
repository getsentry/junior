import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canScheduleTurnTimeoutResume,
  scheduleTurnTimeoutResume,
  verifyTurnTimeoutResumeRequest,
} from "@/chat/services/timeout-resume";

function makeSignedResumeRequest(body: Record<string, unknown>): Request {
  const timestamp = Date.now().toString();
  const serializedBody = JSON.stringify(body);
  const signature = createHmac("sha256", "resume-secret")
    .update(`junior.turn_timeout_resume.v1:${timestamp}:${serializedBody}`)
    .digest("hex");
  return new Request("https://junior.example.com/api/internal/turn-resume", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-junior-resume-timestamp": timestamp,
      "x-junior-resume-signature": `v1=${signature}`,
    },
    body: serializedBody,
  });
}

describe("timeout resume callback signing", () => {
  const originalFetch = global.fetch;
  const originalSlackSigningSecret = process.env.SLACK_SIGNING_SECRET;

  beforeEach(() => {
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "resume-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    if (originalSlackSigningSecret === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = originalSlackSigningSecret;
    }
    vi.restoreAllMocks();
  });

  it("signs scheduled callbacks so the handler can verify them", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    await scheduleTurnTimeoutResume({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://junior.example.com/api/internal/turn-resume");

    const request = new Request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    await expect(verifyTurnTimeoutResumeRequest(request)).resolves.toEqual({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });
  });

  it("accepts the previous expected checkpoint version field", async () => {
    const request = makeSignedResumeRequest({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedCheckpointVersion: 3,
    });

    await expect(verifyTurnTimeoutResumeRequest(request)).resolves.toEqual({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });
  });

  it("rejects requests whose signature does not match the body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    await scheduleTurnTimeoutResume({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedVersion: 3,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    headers.set("x-junior-resume-signature", "v1=deadbeef");
    const request = new Request(url, {
      method: init.method,
      headers,
      body: init.body,
    });

    await expect(
      verifyTurnTimeoutResumeRequest(request),
    ).resolves.toBeUndefined();
  });

  it("requires the Junior secret instead of the Slack signing secret", async () => {
    delete process.env.JUNIOR_SECRET;
    process.env.SLACK_SIGNING_SECRET = "slack-secret";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      scheduleTurnTimeoutResume({
        conversationId: "slack:C123:1712345.0001",
        sessionId: "turn_msg_1",
        expectedVersion: 3,
      }),
    ).rejects.toThrow("JUNIOR_SECRET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps automatic timeout resume depth", () => {
    expect(canScheduleTurnTimeoutResume(2)).toBe(true);
    expect(canScheduleTurnTimeoutResume(5)).toBe(true);
    expect(canScheduleTurnTimeoutResume(6)).toBe(false);
    expect(canScheduleTurnTimeoutResume(undefined)).toBe(false);
  });
});
