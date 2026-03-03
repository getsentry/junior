import { describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { routeIncomingMessageToWorkflow } from "@/chat/chat-background-patch";

function createMessage(
  overrides: Partial<{
    id: string;
    isMention: boolean;
    isMe: boolean;
    raw: Record<string, unknown>;
  }> = {}
) {
  return {
    id: overrides.id ?? "1700000000.100",
    text: "hello",
    isMention: overrides.isMention ?? false,
    raw: overrides.raw ?? {
      channel: "C123",
      ts: "1700000000.100"
    },
    attachments: [],
    author: {
      userId: "U_TEST",
      isMe: overrides.isMe ?? false
    }
  };
}

function createRuntime() {
  return {
    createThread: vi.fn(async () => ({ channelId: "slack:C123" })),
    detectMention: vi.fn(() => false)
  };
}

function createDeps(overrides: Partial<{
  claimDedup: (key: string, ttlMs: number) => Promise<boolean>;
  getIsSubscribed: (threadId: string) => Promise<boolean>;
  logInfo: (...args: unknown[]) => void;
  routeToThreadWorkflow: (normalizedThreadId: string, payload: ThreadMessagePayload) => Promise<void>;
}> = {}) {
  return {
    claimDedup: overrides.claimDedup ?? vi.fn(async () => true),
    getIsSubscribed: overrides.getIsSubscribed ?? vi.fn(async () => false),
    logInfo: overrides.logInfo ?? vi.fn(),
    routeToThreadWorkflow: overrides.routeToThreadWorkflow ?? vi.fn(async () => undefined)
  };
}

describe("routeIncomingMessageToWorkflow", () => {
  it("routes subscribed thread messages", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true)
    });
    const message = createMessage({
      isMention: false
    });

    const result = await routeIncomingMessageToWorkflow({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps
    });

    expect(result).toBe("routed");
    expect(deps.routeToThreadWorkflow).toHaveBeenCalledTimes(1);
    const [, payload] = (deps.routeToThreadWorkflow as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      ThreadMessagePayload
    ];
    expect(payload.kind).toBe("subscribed_message");
  });

  it("does not claim dedupe key for unsubscribed non-mention messages", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => false)
    });
    const message = createMessage({
      isMention: false
    });

    const result = await routeIncomingMessageToWorkflow({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps
    });

    expect(result).toBe("ignored_unsubscribed_non_mention");
    expect(deps.claimDedup).not.toHaveBeenCalled();
    expect(deps.routeToThreadWorkflow).not.toHaveBeenCalled();
  });

  it("returns duplicate result when dedupe claim fails", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => false),
      claimDedup: vi.fn(async () => false)
    });
    const message = createMessage({
      isMention: true
    });

    const result = await routeIncomingMessageToWorkflow({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps
    });

    expect(result).toBe("ignored_duplicate");
    expect(deps.routeToThreadWorkflow).not.toHaveBeenCalled();
  });
});
