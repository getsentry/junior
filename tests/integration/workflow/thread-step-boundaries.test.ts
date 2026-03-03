import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const mocks = vi.hoisted(() => ({
  downloadPrivateSlackFile: vi.fn(async () => Buffer.from("rehydrated-data")),
  handleNewMention: vi.fn(async () => undefined),
  handleSubscribedMessage: vi.fn(async () => undefined),
  logError: vi.fn(),
  logInfo: vi.fn(),
  registerSingleton: vi.fn(),
  withContext: vi.fn(async (_context: unknown, callback: () => Promise<unknown>) => callback()),
  withSpan: vi.fn(async (_name: string, _op: string, _context: unknown, callback: () => Promise<unknown>) => callback())
}));

vi.mock("@/chat/bot", () => ({
  appSlackRuntime: {
    handleNewMention: mocks.handleNewMention,
    handleSubscribedMessage: mocks.handleSubscribedMessage
  },
  bot: {
    registerSingleton: mocks.registerSingleton
  }
}));

vi.mock("@/chat/slack-actions/client", () => ({
  downloadPrivateSlackFile: mocks.downloadPrivateSlackFile
}));

vi.mock("@/chat/observability", () => ({
  logError: mocks.logError,
  logInfo: mocks.logInfo,
  withContext: mocks.withContext,
  withSpan: mocks.withSpan
}));

import { processThreadMessage, runThreadMessageLoop } from "@/chat/workflow/thread-workflow";

function createPayload(
  overrides: Partial<ThreadMessagePayload> = {}
): ThreadMessagePayload {
  const dedupKey = overrides.dedupKey ?? "slack:C123:1700000000.100:1700000000.200";
  const normalizedThreadId = overrides.normalizedThreadId ?? "slack:C123:1700000000.100";

  return {
    dedupKey,
    kind: overrides.kind ?? "new_mention",
    message:
      overrides.message ??
      ({
        id: dedupKey.split(":").at(-1) ?? "1700000000.200",
        author: {
          userId: "U_TEST"
        },
        attachments: []
      } as unknown as ThreadMessagePayload["message"]),
    normalizedThreadId,
    thread:
      overrides.thread ??
      ({
        channelId: "slack:C123"
      } as unknown as ThreadMessagePayload["thread"])
  };
}

async function* toAsyncIterable(items: ThreadMessagePayload[]): AsyncIterable<ThreadMessagePayload> {
  for (const item of items) {
    yield item;
  }
}

describe("thread workflow step boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches new mentions through the step and rehydrates attachment fetchers", async () => {
    const attachment: {
      url: string;
      fetchData?: () => Promise<Buffer>;
    } = {
      url: "https://files.slack.com/private/new-file"
    };
    const payload = createPayload({
      kind: "new_mention",
      message: {
        id: "1700000000.300",
        author: { userId: "U_TEST" },
        attachments: [attachment]
      } as unknown as ThreadMessagePayload["message"]
    });

    await processThreadMessage(payload);

    expect((processThreadMessage as { maxRetries?: number }).maxRetries).toBe(1);
    expect(mocks.registerSingleton).toHaveBeenCalledTimes(1);
    expect(mocks.handleNewMention).toHaveBeenCalledWith(payload.thread, payload.message);
    expect(mocks.handleSubscribedMessage).not.toHaveBeenCalled();
    expect(mocks.withSpan).toHaveBeenCalledTimes(1);
    expect(typeof attachment.fetchData).toBe("function");
    const content = await attachment.fetchData?.();
    expect(content).toEqual(Buffer.from("rehydrated-data"));
    expect(mocks.downloadPrivateSlackFile).toHaveBeenCalledWith("https://files.slack.com/private/new-file");
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "workflow_message_processed",
      {},
      expect.objectContaining({
        "messaging.message.id": "1700000000.300"
      }),
      "Thread workflow step processed message"
    );
  });

  it("dispatches subscribed messages and keeps existing attachment fetchers intact", async () => {
    const existingFetcher = vi.fn(async () => Buffer.from("existing"));
    const attachment: {
      url: string;
      fetchData?: () => Promise<Buffer>;
    } = {
      url: "https://files.slack.com/private/existing-file",
      fetchData: existingFetcher
    };
    const payload = createPayload({
      kind: "subscribed_message",
      message: {
        id: "1700000000.400",
        author: { userId: "U_TEST" },
        attachments: [attachment]
      } as unknown as ThreadMessagePayload["message"]
    });

    await processThreadMessage(payload);

    expect(mocks.handleSubscribedMessage).toHaveBeenCalledWith(payload.thread, payload.message);
    expect(mocks.handleNewMention).not.toHaveBeenCalled();
    expect(attachment.fetchData).toBe(existingFetcher);
    expect(mocks.downloadPrivateSlackFile).not.toHaveBeenCalled();
  });

  it("uses default processing error handler and keeps the workflow loop alive", async () => {
    const payloadA = createPayload({ dedupKey: "slack:C123:1700000000.100:1" });
    const payloadB = createPayload({ dedupKey: "slack:C123:1700000000.100:2" });
    const processed: string[] = [];

    await runThreadMessageLoop(toAsyncIterable([payloadA, payloadB]), {
      processMessage: async (payload) => {
        processed.push(payload.dedupKey);
        if (payload.dedupKey.endsWith(":1")) {
          throw new Error("turn failed");
        }
      }
    });

    expect(processed).toEqual(["slack:C123:1700000000.100:1", "slack:C123:1700000000.100:2"]);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it("keeps workflow loop alive when attachment download fails during handler execution", async () => {
    mocks.downloadPrivateSlackFile.mockRejectedValueOnce(new Error("download failed"));
    mocks.handleNewMention.mockImplementation(async (...args: unknown[]) => {
      const message = args[1] as ThreadMessagePayload["message"];
      const attachment = message.attachments[0];
      if (attachment?.fetchData) {
        await attachment.fetchData();
      }
    });

    const payloadA = createPayload({
      dedupKey: "slack:C123:1700000000.100:1",
      message: {
        id: "1700000000.500",
        author: { userId: "U_TEST" },
        attachments: [{ url: "https://files.slack.com/private/failing-file" }]
      } as unknown as ThreadMessagePayload["message"]
    });
    const payloadB = createPayload({
      dedupKey: "slack:C123:1700000000.100:2",
      message: {
        id: "1700000000.600",
        author: { userId: "U_TEST" },
        attachments: []
      } as unknown as ThreadMessagePayload["message"]
    });

    await runThreadMessageLoop(toAsyncIterable([payloadA, payloadB]));

    expect(mocks.handleNewMention).toHaveBeenCalledTimes(2);
    expect(mocks.logError).toHaveBeenCalledWith(
      "workflow_message_failed",
      {},
      expect.objectContaining({
        "messaging.message.id": "1700000000.500",
        "error.message": "download failed"
      }),
      "Thread workflow step failed"
    );
  });
});
