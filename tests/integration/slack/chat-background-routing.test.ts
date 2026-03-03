import { describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { WORKFLOW_INGRESS_DEDUP_TTL_MS, routeIncomingMessageToWorkflow } from "@/chat/chat-background-patch";

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
  routeToThreadWorkflow: (normalizedThreadId: string, payload: ThreadMessagePayload) => Promise<string | undefined>;
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

  it("routes explicit mentions in unsubscribed threads without fallback detection", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => false),
      routeToThreadWorkflow: vi.fn(async () => "wrun_123")
    });
    const message = createMessage({
      id: "1700000000.300",
      isMention: true
    });

    const result = await routeIncomingMessageToWorkflow({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps
    });

    expect(result).toBe("routed");
    expect(runtime.detectMention).not.toHaveBeenCalled();
    expect(deps.claimDedup).toHaveBeenCalledWith("slack:C123:1700000000.100:1700000000.300", WORKFLOW_INGRESS_DEDUP_TTL_MS);
    const [normalizedThreadId, payload] = (deps.routeToThreadWorkflow as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      ThreadMessagePayload
    ];
    expect(normalizedThreadId).toBe("slack:C123:1700000000.100");
    expect(payload.kind).toBe("new_mention");
    expect(deps.logInfo).toHaveBeenCalledWith(
      "workflow_ingress_enqueued",
      {},
      expect.objectContaining({
        "app.workflow.run_id": "wrun_123"
      }),
      "Routing incoming message to thread workflow"
    );
  });

  it("routes fallback mention detection when SDK mention flag is false", async () => {
    const runtime = createRuntime();
    runtime.detectMention = vi.fn(() => true);
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

    expect(result).toBe("routed");
    expect(runtime.detectMention).toHaveBeenCalledTimes(1);
    const [, payload] = (deps.routeToThreadWorkflow as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      ThreadMessagePayload
    ];
    expect(payload.kind).toBe("new_mention");
  });

  it("normalizes thread identity from raw slack fields before dedupe and routing", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true)
    });
    const message = createMessage({
      id: "1700000000.777",
      raw: {
        channel: "C777",
        thread_ts: "1700000000.555",
        ts: "1700000000.888"
      }
    }) as ReturnType<typeof createMessage> & { threadId?: string };
    message.threadId = "slack:WRONG:";

    const result = await routeIncomingMessageToWorkflow({
      adapter: {},
      threadId: "slack:WRONG:",
      message,
      runtime,
      deps
    });

    expect(result).toBe("routed");
    expect(deps.getIsSubscribed).toHaveBeenCalledWith("slack:C777:1700000000.555");
    expect(deps.claimDedup).toHaveBeenCalledWith("slack:C777:1700000000.555:1700000000.777", WORKFLOW_INGRESS_DEDUP_TTL_MS);
    const [normalizedThreadId, payload] = (deps.routeToThreadWorkflow as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      ThreadMessagePayload
    ];
    expect(normalizedThreadId).toBe("slack:C777:1700000000.555");
    expect(payload.normalizedThreadId).toBe("slack:C777:1700000000.555");
    expect(payload.dedupKey).toBe("slack:C777:1700000000.555:1700000000.777");
    expect(message.threadId).toBe("slack:C777:1700000000.555");
  });

  it("ignores self-authored messages before workflow routing", async () => {
    const runtime = createRuntime();
    const deps = createDeps();
    const message = createMessage({
      isMe: true,
      isMention: true
    });

    const result = await routeIncomingMessageToWorkflow({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps
    });

    expect(result).toBe("ignored_self_message");
    expect(deps.claimDedup).not.toHaveBeenCalled();
    expect(deps.routeToThreadWorkflow).not.toHaveBeenCalled();
  });
});
