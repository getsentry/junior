import { beforeEach, describe, expect, it, vi } from "vitest";
const { abandonTurnRecord } = vi.hoisted(() => ({
  abandonTurnRecord: vi.fn(),
}));

vi.mock("@/chat/task-execution/turn-cursor", () => ({
  abandonTurnRecord,
}));

import {
  abandonReplacedPendingAuth,
  canReusePendingAuthLink,
  clearPendingAuth,
  isPendingAuthFor,
} from "@/chat/services/pending-auth";
import type {
  ConversationPendingAuthState,
  ThreadConversationState,
} from "@/chat/state/conversation";

const NOW = 1_700_000_000_000;
const REUSE_WINDOW_MS = 10 * 60 * 1000;

beforeEach(() => {
  abandonTurnRecord.mockReset();
});

function pendingAuth(
  overrides: Partial<{
    kind: "mcp" | "plugin";
    provider: string;
    actorId: string;
    sessionId: string;
    linkSentAtMs: number;
  }> = {},
): ConversationPendingAuthState {
  const { kind = "mcp", ...rest } = overrides;
  const value = {
    provider: "eval-auth",
    actorId: "U123",
    sessionId: "run_1",
    linkSentAtMs: NOW - 60_000,
    ...rest,
  };
  return kind === "mcp"
    ? { ...value, authSessionId: "auth-session-1", kind }
    : { ...value, kind };
}

function pendingAuthState(sessionId: string): ConversationPendingAuthState {
  return {
    kind: "plugin",
    provider: "eval-auth",
    actorId: "U123",
    sessionId,
    linkSentAtMs: NOW,
  };
}

describe("canReusePendingAuthLink", () => {
  it("reuses a fresh link within the reuse window", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        actorId: "U123",
        sessionId: "run_1",
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
        actorId: "U123",
        sessionId: "run_1",
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
        actorId: "U123",
        sessionId: "run_1",
        pendingAuth: pendingAuth({ linkSentAtMs: NOW - REUSE_WINDOW_MS }),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("does not reuse a link from a different actor or provider", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        actorId: "U999",
        sessionId: "run_1",
        pendingAuth: pendingAuth(),
        nowMs: NOW,
      }),
    ).toBe(false);

    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "other-provider",
        actorId: "U123",
        sessionId: "run_1",
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
        actorId: "U123",
        sessionId: "run_1",
        pendingAuth: pendingAuth({ kind: "mcp" }),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("does not reuse a link from a different session", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        actorId: "U123",
        sessionId: "run_2",
        pendingAuth: pendingAuth(),
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when there is no pending auth record", () => {
    expect(
      canReusePendingAuthLink({
        kind: "mcp",
        provider: "eval-auth",
        actorId: "U123",
        sessionId: "run_1",
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

describe("abandonReplacedPendingAuth", () => {
  it("abandons a prior blocked session after replacement succeeds", async () => {
    const previousPendingAuth = pendingAuthState("run_old");
    const nextPendingAuth = pendingAuthState("run_new");

    await abandonReplacedPendingAuth({
      conversationId: "conversation-1",
      previousPendingAuth,
      nextPendingAuth,
    });

    expect(abandonTurnRecord).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      turnId: "run_old",
      errorMessage:
        "Abandoned by a newer auth-blocked request in the same conversation.",
    });
  });
});

describe("clearPendingAuth", () => {
  it("keeps a newer wait when an older Turn ends", () => {
    const conversation: ThreadConversationState = {
      schemaVersion: 1,
      messages: [],
      processing: { pendingAuth: pendingAuth({ sessionId: "run_2" }) },
      vision: { byFileId: {} },
    };

    clearPendingAuth(conversation, "run_1");
    expect(conversation.processing.pendingAuth?.sessionId).toBe("run_2");

    clearPendingAuth(conversation, "run_2");
    expect(conversation.processing.pendingAuth).toBeUndefined();
  });
});

describe("isPendingAuthFor", () => {
  const authorization = {
    actorId: "U123",
    authSessionId: "auth-session-1",
    kind: "mcp" as const,
    provider: "eval-auth",
    turnId: "run_1",
  };

  it("matches the authorization for the same wait", () => {
    expect(isPendingAuthFor(pendingAuth(), authorization)).toBe(true);
  });

  it("rejects an authorization for another attempt, Turn, or scope", () => {
    expect(
      isPendingAuthFor(pendingAuth(), {
        ...authorization,
        authSessionId: "auth-session-2",
      }),
    ).toBe(false);
    expect(
      isPendingAuthFor(pendingAuth(), { ...authorization, turnId: "run_2" }),
    ).toBe(false);
    expect(
      isPendingAuthFor(pendingAuth(), { ...authorization, scope: "repo" }),
    ).toBe(false);
  });
});
