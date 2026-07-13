import { beforeEach, describe, expect, it, vi } from "vitest";
const { abandonAgentTurnSessionRecord } = vi.hoisted(() => ({
  abandonAgentTurnSessionRecord: vi.fn(),
}));

vi.mock("@/chat/state/turn-session", () => ({
  abandonAgentTurnSessionRecord,
}));

import {
  abandonReplacedPendingAuth,
  canReusePendingAuthLink,
  isPendingAuthLatestRequest,
} from "@/chat/services/pending-auth";
import type {
  ConversationPendingAuthState,
  ThreadConversationState,
} from "@/chat/state/conversation";

const NOW = 1_700_000_000_000;
const REUSE_WINDOW_MS = 10 * 60 * 1000;

beforeEach(() => {
  abandonAgentTurnSessionRecord.mockReset();
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

function conversationWithMessages(
  messages: ThreadConversationState["messages"],
): ThreadConversationState {
  return {
    schemaVersion: 1,
    messages,
    compactions: [],
    backfill: {},
    processing: {},
    stats: {
      compactedMessageCount: 0,
      estimatedContextTokens: 0,
      totalMessageCount: messages.length,
      updatedAtMs: NOW,
    },
    vision: {
      byFileId: {},
    },
  };
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

    expect(abandonAgentTurnSessionRecord).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      sessionId: "run_old",
      errorMessage:
        "Abandoned by a newer auth-blocked request in the same conversation.",
    });
  });
});

describe("isPendingAuthLatestRequest", () => {
  it("ignores passive skipped bystander messages when checking pending auth freshness", () => {
    expect(
      isPendingAuthLatestRequest(
        conversationWithMessages([
          {
            id: "msg.9",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: NOW,
          },
          {
            id: "msg.bystander",
            role: "user",
            text: "I think those tools are read only",
            createdAtMs: NOW + 1,
            meta: {
              replied: false,
              skippedReason: "side_conversation:passive side conversation",
            },
          },
        ]),
        pendingAuthState("turn_msg_9"),
      ),
    ).toBe(true);
  });

  it("ignores messages directed to another party when checking pending auth freshness", () => {
    expect(
      isPendingAuthLatestRequest(
        conversationWithMessages([
          {
            id: "msg.9",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: NOW,
          },
          {
            id: "msg.other-party",
            role: "user",
            text: "@cursor can you check this?",
            createdAtMs: NOW + 1,
            meta: {
              replied: false,
              skippedReason: "directed_to_other_party:named_mention:Cursor",
            },
          },
        ]),
        pendingAuthState("turn_msg_9"),
      ),
    ).toBe(true);
  });

  it("treats failed user turns as newer requests when checking pending auth freshness", () => {
    expect(
      isPendingAuthLatestRequest(
        conversationWithMessages([
          {
            id: "msg.9",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: NOW,
          },
          {
            id: "msg.failed",
            role: "user",
            text: "sync this with github",
            createdAtMs: NOW + 1,
            meta: {
              replied: false,
              skippedReason: "reply failed",
            },
          },
        ]),
        pendingAuthState("turn_msg_9"),
      ),
    ).toBe(false);
  });

  it("ignores failed bot-authored turns when checking pending auth freshness", () => {
    expect(
      isPendingAuthLatestRequest(
        conversationWithMessages([
          {
            id: "msg.9",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: NOW,
            author: {
              userId: "U123",
              userName: "dcramer",
            },
          },
          {
            id: "msg.bot-failed",
            role: "user",
            text: "sync this with github",
            createdAtMs: NOW + 1,
            author: {
              isBot: true,
              userId: "UBOT",
              userName: "github",
            },
            meta: {
              replied: false,
              skippedReason: "reply failed",
            },
          },
        ]),
        pendingAuthState("turn_msg_9"),
      ),
    ).toBe(true);
  });

  it("does not ignore failed human turns from other users when checking pending auth freshness", () => {
    expect(
      isPendingAuthLatestRequest(
        conversationWithMessages([
          {
            id: "msg.9",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: NOW,
            author: {
              userId: "U123",
              userName: "dcramer",
            },
          },
          {
            id: "msg.other-human-failed",
            role: "user",
            text: "sync this with github",
            createdAtMs: NOW + 1,
            author: {
              userId: "U999",
              userName: "human",
            },
            meta: {
              replied: false,
              skippedReason: "reply failed",
            },
          },
        ]),
        pendingAuthState("turn_msg_9"),
      ),
    ).toBe(false);
  });

  it("treats thread opt-out turns as newer requests when checking pending auth freshness", () => {
    expect(
      isPendingAuthLatestRequest(
        conversationWithMessages([
          {
            id: "msg.9",
            role: "user",
            text: "list my sentry issues",
            createdAtMs: NOW,
          },
          {
            id: "msg.opt-out",
            role: "user",
            text: "stop replying here",
            createdAtMs: NOW + 1,
            meta: {
              replied: false,
              skippedReason: "thread_opt_out:explicit stop instruction",
            },
          },
        ]),
        pendingAuthState("turn_msg_9"),
      ),
    ).toBe(false);
  });
});
