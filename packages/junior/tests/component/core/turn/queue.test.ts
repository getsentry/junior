import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  QueueMessageMetadata,
  QueueSendOptions,
} from "@/chat/queue/provider";
import { QUEUE_SIGNATURE_MAX_AGE_MS } from "@/chat/queue/sign";
import * as Sentry from "@/chat/sentry";
import { setActiveSpanAttributes } from "@/core/telemetry";
import {
  publishTurnStep,
  TURN_STEP_TOPIC,
  turnStepCallback,
  type RunTurnStep,
} from "@/core/turn/queue";

const TURN_ID = "turn_1";
const originalJuniorSecret = process.env["JUNIOR_SECRET"];

function deliveryOf(createdAt = new Date()): QueueMessageMetadata {
  return {
    consumerGroup: "junior_turn_step",
    createdAt,
    deliveryCount: 2,
    messageId: "msg_1",
    topicName: TURN_STEP_TOPIC,
  };
}

describe("turn step queue", () => {
  const spans: ReturnType<typeof Sentry.spanToJSON>[] = [];
  const sent: {
    topic: string;
    payload: unknown;
    options?: QueueSendOptions;
  }[] = [];
  const queue = {
    messagingSystem: "test_queue",
    send: async (
      topic: string,
      payload: unknown,
      options?: QueueSendOptions,
    ) => {
      sent.push({ topic, payload, options });
      return { messageId: "msg_1" };
    },
  };
  let client: ReturnType<typeof Sentry.init>;

  beforeAll(() => {
    client = Sentry.init({
      dsn: "https://public@example.com/1",
      tracesSampleRate: 1,
      defaultIntegrations: false,
      transport: () => ({
        send: async () => ({ statusCode: 200 }),
        flush: async () => true,
      }),
    });
    client?.on("spanEnd", (span) => {
      spans.push(Sentry.spanToJSON(span));
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(() => {
    spans.length = 0;
    sent.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env["JUNIOR_SECRET"] = originalJuniorSecret;
  });

  const byOp = (op: string) =>
    spans.filter((span) => span.attributes?.["sentry.op"] === op);

  async function publishFromRequest(
    options?: Parameters<typeof publishTurnStep>[1],
  ) {
    await Sentry.startSpan({ name: "http.server", op: "http.server" }, () =>
      publishTurnStep(TURN_ID, options, queue),
    );
    return sent.at(-1)!.payload;
  }

  it("publishes a signed message with the delay and idempotency key", async () => {
    await publishFromRequest({ delayMs: 1_500, idempotencyKey: "turn_1:1" });

    expect(sent).toEqual([
      {
        topic: TURN_STEP_TOPIC,
        payload: expect.objectContaining({
          turnId: TURN_ID,
          traceContext: { sentryTrace: expect.any(String) },
          signature: expect.any(String),
        }),
        options: {
          delaySeconds: 2,
          idempotencyKey: "turn_1:1",
          retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
        },
      },
    ]);
    expect(byOp("queue.publish")).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "app.turn.id": TURN_ID,
          "messaging.destination.name": TURN_STEP_TOPIC,
          "messaging.system": "test_queue",
          "messaging.message.id": "msg_1",
          "messaging.message.body.size": expect.any(Number),
        }),
      }),
    ]);
  });

  it("runs a verified message in a new trace that links to the publisher", async () => {
    const payload = await publishFromRequest();
    const [publish] = byOp("queue.publish");
    const run = vi.fn<RunTurnStep>(async () => {
      setActiveSpanAttributes({
        "app.turn.step_seq": 3,
        "gen_ai.conversation.id": "slack:C123:1",
      });
    });
    const delivery = deliveryOf();

    await turnStepCallback(run).consumer.handler(payload, delivery);

    expect(run).toHaveBeenCalledWith({ turnId: TURN_ID }, delivery);
    const [processed] = byOp("queue.process");
    expect(processed?.trace_id).not.toBe(publish?.trace_id);
    expect(processed).toMatchObject({
      links: [
        expect.objectContaining({
          trace_id: publish?.trace_id,
          span_id: publish?.span_id,
        }),
      ],
      attributes: expect.objectContaining({
        "app.turn.id": TURN_ID,
        "app.turn.step_seq": 3,
        "gen_ai.conversation.id": "slack:C123:1",
        "messaging.destination.name": TURN_STEP_TOPIC,
        "messaging.message.id": "msg_1",
        "messaging.message.retry.count": 1,
      }),
    });
  });

  it("acknowledges a changed or expired message without running it", async () => {
    const payload = await publishFromRequest();
    const run = vi.fn<RunTurnStep>(async () => {});
    const { consumer } = turnStepCallback(run);

    await expect(
      consumer.handler(
        Object.assign({}, payload, { turnId: "turn_2" }),
        deliveryOf(),
      ),
    ).resolves.toBeUndefined();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + QUEUE_SIGNATURE_MAX_AGE_MS + 1);
    await expect(
      consumer.handler(payload, deliveryOf()),
    ).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(byOp("queue.process")).toEqual([]);
  });

  it("retries a message whose signature cannot be checked", async () => {
    const payload = await publishFromRequest();
    const run = vi.fn<RunTurnStep>(async () => {});
    delete process.env["JUNIOR_SECRET"];

    await expect(
      turnStepCallback(run).consumer.handler(payload, deliveryOf()),
    ).rejects.toThrow("Queue message verification unavailable");
    expect(run).not.toHaveBeenCalled();
  });
});
