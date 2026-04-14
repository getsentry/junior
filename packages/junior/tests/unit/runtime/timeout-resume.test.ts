import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canScheduleTurnTimeoutResume,
  scheduleTurnTimeoutResume,
  verifyTurnTimeoutResumeRequest,
} from "@/chat/services/timeout-resume";

describe("timeout resume callback signing", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_INTERNAL_RESUME_SECRET = "resume-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_INTERNAL_RESUME_SECRET;
    vi.restoreAllMocks();
  });

  it("signs scheduled callbacks so the handler can verify them", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    await scheduleTurnTimeoutResume({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedCheckpointVersion: 3,
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
      expectedCheckpointVersion: 3,
    });
  });

  it("rejects requests whose signature does not match the body", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    await scheduleTurnTimeoutResume({
      conversationId: "slack:C123:1712345.0001",
      sessionId: "turn_msg_1",
      expectedCheckpointVersion: 3,
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

  it("caps automatic timeout resume depth", () => {
    expect(canScheduleTurnTimeoutResume(2)).toBe(true);
    expect(canScheduleTurnTimeoutResume(5)).toBe(true);
    expect(canScheduleTurnTimeoutResume(6)).toBe(false);
    expect(canScheduleTurnTimeoutResume(undefined)).toBe(false);
  });
});
