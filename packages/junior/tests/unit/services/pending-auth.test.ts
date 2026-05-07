import { describe, expect, it } from "vitest";
import { canReusePendingAuthLink } from "@/chat/services/pending-auth";

const NOW = 1_700_000_000_000;
const REUSE_WINDOW_MS = 10 * 60 * 1000;

function pendingAuth(
  overrides: Partial<{
    kind: "mcp" | "plugin";
    provider: string;
    requesterId: string;
    sessionId: string;
    linkSentAtMs: number;
  }> = {},
) {
  return {
    kind: "mcp" as const,
    provider: "eval-auth",
    requesterId: "U123",
    sessionId: "turn_1",
    linkSentAtMs: NOW - 60_000,
    ...overrides,
  };
}

describe("canReusePendingAuthLink", () => {
  it("reuses a fresh link within the reuse window", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        requesterId: "U123",
        pendingAuth: pendingAuth({ linkSentAtMs: NOW - 60_000 }),
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("reuses a link one millisecond before the window expires", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        requesterId: "U123",
        pendingAuth: pendingAuth({
          linkSentAtMs: NOW - REUSE_WINDOW_MS + 1,
        }),
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("issues a fresh link once the reuse window has elapsed", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        requesterId: "U123",
        pendingAuth: pendingAuth({ linkSentAtMs: NOW - REUSE_WINDOW_MS }),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("does not reuse a link from a different requester or provider", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        requesterId: "U999",
        pendingAuth: pendingAuth(),
        nowMs: NOW,
      }),
    ).toBe(false);

    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "other-provider",
        requesterId: "U123",
        pendingAuth: pendingAuth(),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("does not reuse an MCP link for a plugin pause (or vice versa)", () => {
    expect(
      canReusePendingAuthLink({
        kind: "plugin",
        provider: "eval-auth",
        requesterId: "U123",
        pendingAuth: pendingAuth({ kind: "mcp" }),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when there is no pending auth record", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        requesterId: "U123",
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});
