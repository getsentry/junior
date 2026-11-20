// Core ports chat's `gen_ai.chat` span. This test feeds the same stub stream
// to both and fails when their spans differ, so a change to chat's span must
// also change core's.
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
} from "@earendil-works/pi-ai";
import { resolveGatewayModel } from "@/chat/pi/client";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import { tracedStream, type ModelStream } from "@/core/model/span";

type RecordedSpan = Pick<
  ReturnType<typeof Sentry.spanToJSON>,
  "name" | "status" | "attributes"
>;

const spans: RecordedSpan[] = [];

beforeAll(() => {
  const client = Sentry.init({
    dsn: "https://public@example.com/1",
    tracesSampleRate: 1,
    defaultIntegrations: false,
    transport: () => ({
      send: async () => ({ statusCode: 200 }),
      flush: async () => true,
    }),
  });
  client?.on("spanEnd", (span) => {
    const { name, status, attributes } = Sentry.spanToJSON(span);
    if (attributes["sentry.op"] === "gen_ai.chat") {
      spans.push({ name, status, attributes });
    }
  });
});

afterAll(async () => {
  await Sentry.getClient()?.close();
});

// These values depend on the clock and the event loop, not on the request.
const TIMING_KEYS = [
  "app.ai.event_loop.utilization",
  "app.ai.time_to_first_byte_ms",
  "gen_ai.response.time_to_first_chunk",
];

const model = resolveGatewayModel("anthropic/claude-opus-5.5");

const context: Context = {
  systemPrompt: "you are junior. API_KEY=supersecretvalue",
  messages: [
    { role: "user", content: "hello", timestamp: 0 },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  ],
};

const payload = {
  system: [{ type: "text", text: "you are junior" }],
  tools: [{ name: "bash", description: "run", input_schema: {} }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image", source: { type: "base64", data: "aGVsbG8=" } },
      ],
    },
  ],
};

const routingEvent = {
  type: "message_delta",
  provider_metadata: {
    gateway: {
      routing: {
        finalProvider: "anthropic",
        sessionAffinity: { source: "explicit", pinned: true },
      },
    },
  },
};

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi there, token sk-abcdefghijklmnopqrstuvwxyz" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { a: 1 } },
    ],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: "anthropic/claude-opus-5.5",
    responseId: "msg_1",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 300,
      cacheWrite: 40,
      cacheWrite1h: 10,
      reasoning: 5,
      totalTokens: 460,
      cost: {
        input: 0.0004,
        output: 0.0004,
        cacheRead: 0.00006,
        cacheWrite: 0.0002,
        total: 0.00106,
      },
    },
    stopReason: "toolUse",
    timestamp: 2,
    ...overrides,
  };
}

// A stub of `streamSimple` that calls each Pi hook once, then pushes a reply.
function stubStream(message: AssistantMessage): ModelStream {
  return async (_model, _context, options) => {
    await options?.onPayload?.(payload, model);
    await options?.onResponse?.(
      { status: 200, headers: { "x-vercel-id": "iad1::abc" } },
      model,
    );
    await options?.onProviderStreamEvent?.(routingEvent, model);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "text_delta",
      contentIndex: 1,
      delta: "hi",
      partial: message,
    });
    const reason = message.stopReason;
    if (reason === "error" || reason === "aborted") {
      stream.push({ type: "error", reason, error: message });
    } else if (reason !== "pending") {
      stream.push({ type: "done", reason, message });
    }
    return stream;
  };
}

async function record(
  base: ModelStream,
  run: (stream: ModelStream) => Promise<AssistantMessageEventStream>,
): Promise<RecordedSpan> {
  spans.length = 0;
  const stream = await run(base).catch(() => undefined);
  await stream?.result();
  await expect.poll(() => spans.length).toBe(1);
  const span = spans[0]!;
  for (const key of TIMING_KEYS) {
    if (span.attributes[key] !== undefined) {
      span.attributes[key] = "<timing>";
    }
  }
  return span;
}

async function compare(
  privacy: "public" | "private",
  base: ModelStream,
): Promise<void> {
  const options = {
    temperature: 0.2,
    maxTokens: 1000,
    reasoning: "low" as const,
  };
  const chat = await record(base, (stream) =>
    Promise.resolve(
      createTracedStreamFn({ conversationPrivacy: privacy, base: stream })(
        model,
        context,
        options,
      ),
    ),
  );
  const core = await record(base, (stream) =>
    Promise.resolve(tracedStream(stream, privacy)(model, context, options)),
  );
  expect(core).toEqual(chat);
}

describe("model request span", () => {
  it("matches chat's span for a public reply", async () => {
    await compare("public", stubStream(reply()));
  });

  it("matches chat's span for a private reply", async () => {
    await compare("private", stubStream(reply({ stopReason: "stop" })));
  });

  it("matches chat's span for a failed reply", async () => {
    await compare(
      "public",
      stubStream(
        reply({
          content: [],
          stopReason: "error",
          errorMessage:
            '429 {"type":"error","error":{"type":"rate_limit_error"},"retry-after":"7"}',
        }),
      ),
    );
  });

  it("matches chat's span for a refusal", async () => {
    await compare(
      "private",
      stubStream(
        reply({
          stopReason: "error",
          rawStopReason: "refusal",
          errorMessage: "",
        }),
      ),
    );
  });

  it("matches chat's span when the request throws", async () => {
    await compare("private", async () => {
      throw new TypeError("fetch failed");
    });
  });
});
