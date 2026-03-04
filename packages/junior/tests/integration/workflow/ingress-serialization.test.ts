import { describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";
import { routeIncomingMessageToWorkflow } from "@/chat/chat-background-patch";

describe("workflow ingress serialization", () => {
  it("serializes message/thread payloads before routing to workflow", async () => {
    const capturedPayloads: ThreadMessagePayload[] = [];
    const runtime = {
      createThread: vi.fn(async () => ({
        id: "slack:C123:1700000000.100",
        channelId: "C123",
        isDM: false,
        toJSON: () => ({
          _type: "chat:Thread",
          id: "slack:C123:1700000000.100",
          channelId: "C123",
          adapterName: "slack",
          isDM: false
        })
      })),
      detectMention: vi.fn(() => false)
    };
    const deps = {
      hasDedup: vi.fn(async () => false),
      markDedup: vi.fn(async () => true),
      getIsSubscribed: vi.fn(async () => true),
      logInfo: vi.fn(),
      routeToThreadWorkflow: vi.fn(async (_normalizedThreadId: string, payload: ThreadMessagePayload) => {
        capturedPayloads.push(payload);
        return "wrun_123";
      })
    };
    const message = {
      id: "1700000000.200",
      text: "hello",
      isMention: false,
      raw: {
        channel: "C123",
        thread_ts: "1700000000.100",
        ts: "1700000000.200"
      },
      attachments: [
        {
          type: "file",
          url: "https://files.slack.com/private/test.txt",
          fetchData: async () => Buffer.from("private")
        }
      ],
      author: {
        userId: "U_TEST",
        isMe: false
      },
      toJSON: () => ({
        _type: "chat:Message",
        id: "1700000000.200",
        threadId: "slack:C123:1700000000.100",
        text: "hello",
        attachments: [
          {
            type: "file",
            url: "https://files.slack.com/private/test.txt"
          }
        ],
        author: {
          userId: "U_TEST",
          isMe: false
        }
      })
    };

    const result = await routeIncomingMessageToWorkflow({
      adapter: {},
      threadId: "slack:C123:1700000000.100",
      message,
      runtime,
      deps
    });

    expect(result).toBe("routed");
    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0] as ThreadMessagePayload & {
      message: { _type?: string; attachments?: Array<{ fetchData?: unknown }> };
      thread: { _type?: string };
    };
    expect(payload.thread._type).toBe("chat:Thread");
    expect(payload.message._type).toBe("chat:Message");
    expect(payload.message.attachments?.[0]?.fetchData).toBeUndefined();
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});
