import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredThreadMessageError } from "@/chat/queue/errors";

const { createTransportCallbackHandlerMock, sendQueueMessageMock } = vi.hoisted(
  () => ({
    createTransportCallbackHandlerMock: vi.fn(
      (
        _handler: unknown,
        _options?: {
          retry?: (
            error: unknown,
            metadata: { deliveryCount: number },
          ) => unknown;
        },
      ) =>
        async () =>
          new Response("ok", { status: 202 }),
    ),
    sendQueueMessageMock: vi.fn(async () => "msg_123"),
  }),
);

vi.mock("@/chat/queue/transport", () => ({
  createTransportCallbackHandler: createTransportCallbackHandlerMock,
  sendQueueMessage: sendQueueMessageMock,
}));

import {
  createQueueCallbackHandler,
  enqueueThreadMessage,
} from "@/chat/queue/client";

function getRetryHandler(): (
  error: unknown,
  metadata: { deliveryCount: number },
) => unknown {
  createQueueCallbackHandler(async () => undefined);
  const options = createTransportCallbackHandlerMock.mock.calls.at(-1)?.[1] as
    | {
        retry?: (
          error: unknown,
          metadata: { deliveryCount: number },
        ) => unknown;
      }
    | undefined;
  if (!options?.retry) {
    throw new Error("Retry handler was not configured");
  }
  return options.retry;
}

describe("queue client", () => {
  beforeEach(() => {
    createTransportCallbackHandlerMock.mockClear();
    sendQueueMessageMock.mockClear();
  });

  it("retries thread-lock deferrals without acknowledging them away", () => {
    const retry = getRetryHandler();

    expect(
      retry(
        new DeferredThreadMessageError("thread_locked", "slack:C123:1700"),
        { deliveryCount: 1 },
      ),
    ).toEqual({ afterSeconds: 5 });
    expect(
      retry(
        new DeferredThreadMessageError("thread_locked", "slack:C123:1700"),
        { deliveryCount: 99 },
      ),
    ).toEqual({ afterSeconds: 30 });
  });

  it("retries active-turn deferrals without applying the poison-message cap", () => {
    const retry = getRetryHandler();

    expect(
      retry(new DeferredThreadMessageError("active_turn", "slack:C123:1700"), {
        deliveryCount: 1,
      }),
    ).toEqual({ afterSeconds: 30 });
    expect(
      retry(new DeferredThreadMessageError("active_turn", "slack:C123:1700"), {
        deliveryCount: 99,
      }),
    ).toEqual({ afterSeconds: 300 });
  });

  it("still acknowledges generic poison messages after the max delivery cap", () => {
    const retry = getRetryHandler();

    expect(retry(new Error("boom"), { deliveryCount: 10 })).toEqual({
      acknowledge: true,
    });
  });

  it("passes the optional idempotency key through on enqueue", async () => {
    const messageId = await enqueueThreadMessage(
      { text: "hello" },
      { idempotencyKey: "dedup-123" },
    );

    expect(messageId).toBe("msg_123");
    expect(sendQueueMessageMock).toHaveBeenCalledWith(
      "junior-thread-message",
      { text: "hello" },
      { idempotencyKey: "dedup-123" },
    );
  });
});
