import { randomUUID } from "node:crypto";
import * as z from "zod";
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
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import {
  getQueueProvider,
  type QueueConsumer,
  type QueueMessageMetadata,
} from "@/chat/queue/provider";
import { QUEUE_SIGNATURE_MAX_AGE_MS } from "@/chat/queue/sign";
import * as Sentry from "@/chat/sentry";
import { setActiveSpanAttributes } from "@/core/telemetry";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import { publishTurnStep, createTurnStepConsumer } from "@/core/turn/queue";

// Chat config reads the queue API URL when it loads, so pick the port first.
// Each test starts its own local Vercel Queues server on this port.
const { port, previousApiUrl } = await vi.hoisted(async () => {
  const { createServer: createPortProbe } = await import("node:net");
  const probe = createPortProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("No free port for the local queue server");
  }
  const previousApiUrl = process.env["JUNIOR_QUEUE_API_URL"];
  process.env["JUNIOR_QUEUE_API_URL"] = `http://127.0.0.1:${address.port}`;
  return { port: address.port, previousApiUrl };
});

const originalJuniorSecret = process.env["JUNIOR_SECRET"];
const LEASE_MS = 60_000;
const CONSUMER_GROUP = "local";
const CALLBACK_URL = `http://app.localhost/api/queue/${TURN_STEP_TOPIC}`;

type Run = { turnId: string; metadata: QueueMessageMetadata; atMs: number };

// The topic is fixed, so each test uses its own Turn id and reads only the
// runs of that id. A message left by another test or run does not count.
let turnId: string;
let runs: Run[];
let server: LocalVercelQueueServer | undefined;
const spans: ReturnType<typeof Sentry.spanToJSON>[] = [];
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
  // Later test files in this worker read chat config again.
  if (previousApiUrl === undefined) {
    delete process.env["JUNIOR_QUEUE_API_URL"];
  } else {
    process.env["JUNIOR_QUEUE_API_URL"] = previousApiUrl;
  }
});

beforeEach(() => {
  turnId = `turn_${randomUUID()}`;
  runs = [];
  spans.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  process.env["JUNIOR_SECRET"] = originalJuniorSecret;
  await stopConsumer();
});

// The queue and lease parts of the engine context. The consumer only records
// its runs, so it needs no database.
const engineCtx = { queue: getQueueProvider(), leaseMs: LEASE_MS };

/** The step runner that the runner PR adds. It only records its runs. */
const turnStep = createTurnStepConsumer(
  engineCtx,
  async (message, metadata) => {
    setActiveSpanAttributes({
      "app.turn.step_seq": 3,
      "gen_ai.conversation.id": "slack:C123:1",
    });
    runs.push({ turnId: message.turnId, metadata, atMs: Date.now() });
  },
);

/**
 * Start a local queue server that pushes each Turn step message to the
 * consumer's callback, the way the app routes it. The SDK leases each message
 * for at least 30 seconds, so the server cuts leases to 1 second to redeliver
 * sooner.
 */
async function startConsumer(consumer: QueueConsumer): Promise<void> {
  const callback = getQueueProvider().createCallback(consumer);
  server = await startLocalVercelQueueServer({
    consumers: [
      {
        consumerGroup: CONSUMER_GROUP,
        topic: TURN_STEP_TOPIC,
        url: CALLBACK_URL,
      },
    ],
    fetch: async (request) =>
      request.url === CALLBACK_URL
        ? callback(request)
        : new Response(null, { status: 404 }),
    maxLeaseSeconds: 1,
    port,
  });
}

async function stopConsumer(): Promise<void> {
  await server?.close();
  server = undefined;
}

const carriedPayloadSchema = z.looseObject({ turnId: z.string() });

/** Returns the payload when it is a message of this test's Turn. */
function thisTurnPayload(payload: unknown) {
  const parsed = carriedPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.turnId === turnId
    ? parsed.data
    : undefined;
}

/** Run each message of this test's Turn through a plain recording consumer. */
async function recordPayloads(): Promise<Record<string, unknown>[]> {
  const payloads: Record<string, unknown>[] = [];
  await startConsumer({
    ...turnStep,
    handler: async (payload) => {
      const carried = thisTurnPayload(payload);
      if (carried) {
        payloads.push(carried);
      }
    },
  });
  return payloads;
}

function runsOfThisTurn(): Run[] {
  return runs.filter((run) => run.turnId === turnId);
}

function spansOfThisTurn(op: string) {
  return spans.filter(
    (span) =>
      span.attributes?.["sentry.op"] === op &&
      span.attributes["app.turn.id"] === turnId,
  );
}

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for queue delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function publishFromRequest(
  options?: Parameters<typeof publishTurnStep>[2],
): Promise<void> {
  return Sentry.startSpan({ name: "http.server", op: "http.server" }, () =>
    publishTurnStep(engineCtx, turnId, options),
  );
}

describe("turn step queue on the local Vercel Queues server", () => {
  it("sends a signed message with the Turn id", async () => {
    const payloads = await recordPayloads();

    await publishFromRequest();
    await waitFor(() => payloads.length > 0);

    expect(payloads).toEqual([
      {
        turnId,
        traceContext: { sentryTrace: expect.any(String) },
        signature: expect.any(String),
        signatureVersion: "v1",
        signedAtMs: expect.any(Number),
      },
    ]);
  });

  it("runs the step in a new trace that links to the publisher", async () => {
    await startConsumer(turnStep);

    await publishFromRequest();
    await waitFor(() => spansOfThisTurn("queue.process").length > 0);

    const [publish] = spansOfThisTurn("queue.publish");
    const [processed] = spansOfThisTurn("queue.process");
    expect(runsOfThisTurn()).toEqual([
      expect.objectContaining({
        turnId,
        metadata: expect.objectContaining({
          deliveryCount: 1,
          topicName: TURN_STEP_TOPIC,
        }),
      }),
    ]);
    expect(publish).toMatchObject({
      attributes: expect.objectContaining({
        "messaging.destination.name": TURN_STEP_TOPIC,
        "messaging.system": "vercel_queue",
        "messaging.message.id": expect.any(String),
        "messaging.message.body.size": expect.any(Number),
      }),
    });
    expect(processed?.trace_id).not.toBe(publish?.trace_id);
    expect(processed).toMatchObject({
      links: [
        expect.objectContaining({
          trace_id: publish?.trace_id,
          span_id: publish?.span_id,
        }),
      ],
      attributes: expect.objectContaining({
        "app.turn.step_seq": 3,
        "gen_ai.conversation.id": "slack:C123:1",
        "messaging.destination.name": TURN_STEP_TOPIC,
        "messaging.system": "vercel_queue",
        "messaging.message.id": publish?.attributes?.["messaging.message.id"],
        "messaging.message.retry.count": 0,
      }),
    });
  });

  it("holds a delayed message back", async () => {
    await startConsumer(turnStep);

    const sentAtMs = Date.now();
    await publishFromRequest({ delayMs: 1_500 });
    await waitFor(() => runsOfThisTurn().length > 0);

    // The queue counts delays in whole seconds, so 1.5 s becomes 2 s.
    expect(runsOfThisTurn()[0]!.atMs - sentAtMs).toBeGreaterThanOrEqual(1_900);
  });

  it("drops a second send with the same idempotency key", async () => {
    await startConsumer(turnStep);

    const idempotencyKey = `${turnId}:1`;
    await publishFromRequest({ idempotencyKey });
    await publishFromRequest({ idempotencyKey });
    await waitFor(() => runsOfThisTurn().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(runsOfThisTurn()).toHaveLength(1);
  });

  it("acknowledges a changed message without running it", async () => {
    const payloads = await recordPayloads();
    await publishFromRequest();
    await waitFor(() => payloads.length > 0);
    await stopConsumer();
    await startConsumer(turnStep);

    // Change the signed Turn id, then send the real message after it.
    const otherTurnId = `turn_${randomUUID()}`;
    await getQueueProvider().send(TURN_STEP_TOPIC, {
      ...payloads[0],
      turnId: otherTurnId,
    });
    await getQueueProvider().send(TURN_STEP_TOPIC, payloads[0]);
    await waitFor(() => runsOfThisTurn().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(runs.filter((run) => run.turnId === otherTurnId)).toEqual([]);
    expect(runsOfThisTurn()).toHaveLength(1);
  });

  it("retries a message that it cannot check, and runs it once it can", async () => {
    const deliveries: number[] = [];
    await startConsumer({
      ...turnStep,
      handler: (payload, metadata) => {
        if (thisTurnPayload(payload)) {
          deliveries.push(metadata.deliveryCount);
          // The consumer cannot check the first delivery.
          if (metadata.deliveryCount === 1) {
            delete process.env["JUNIOR_SECRET"];
          }
        }
        return turnStep.handler(payload, metadata);
      },
    });
    await publishFromRequest();

    await waitFor(() => deliveries.length > 0);
    process.env["JUNIOR_SECRET"] = originalJuniorSecret;
    await waitFor(() => runsOfThisTurn().length > 0);

    expect(runsOfThisTurn()).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ deliveryCount: 2 }),
      }),
    ]);
  });

  // A queue server cannot run under a fake clock, so this case calls the
  // consumer's handler with a message that the queue really carried.
  it("acknowledges an expired message without running it", async () => {
    const payloads = await recordPayloads();
    await publishFromRequest();
    await waitFor(() => payloads.length > 0);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + QUEUE_SIGNATURE_MAX_AGE_MS + 1);
    await expect(
      turnStep.handler(payloads[0], {
        consumerGroup: CONSUMER_GROUP,
        createdAt: new Date(),
        deliveryCount: 1,
        messageId: "expired",
        topicName: TURN_STEP_TOPIC,
      }),
    ).resolves.toBeUndefined();

    expect(runsOfThisTurn()).toEqual([]);
  });
});
