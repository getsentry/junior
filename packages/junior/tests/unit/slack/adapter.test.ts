import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSlackAdapterMock } = vi.hoisted(() => ({
  createSlackAdapterMock: vi.fn(),
}));

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: createSlackAdapterMock,
}));

import { createJuniorSlackAdapter } from "@/chat/slack/adapter";

describe("createJuniorSlackAdapter", () => {
  beforeEach(() => {
    createSlackAdapterMock.mockReset();
  });

  it("forces Junior's stream buffer size even if callers pass a different value", () => {
    const originalChatStream = vi.fn((_params: Record<string, unknown>) => ({
      append: vi.fn(),
      stop: vi.fn(),
    }));
    const adapter = {
      client: {
        chatStream: originalChatStream,
      },
      decodeThreadId: vi.fn(),
      getToken: vi.fn(),
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
      stream: vi.fn(),
    };
    createSlackAdapterMock.mockReturnValue(adapter);

    createJuniorSlackAdapter();
    adapter.client.chatStream({
      buffer_size: 512,
      channel: "C123",
      thread_ts: "1700000000.001",
    });

    expect(originalChatStream).toHaveBeenCalledWith({
      buffer_size: 64,
      channel: "C123",
      thread_ts: "1700000000.001",
    });
  });
});
