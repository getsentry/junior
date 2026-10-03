/**
 * AI Gateway observer for the agent test fixture.
 *
 * Every model request goes to the real AI Gateway. This observer holds agent
 * requests with tools while a test reacts. It also reads numeric usage from
 * Messages responses during a call. It never changes a request or a response.
 * Image generation is the one exception: it is a third-party image API, so
 * the observer answers it with a 1x1 PNG.
 */
import { bypass, http, HttpResponse, passthrough } from "msw";
import { mswServer } from "@junior-tests/msw/server";
import { calculateCost } from "@/chat/pi/sdk";
import { resolveGatewayModel } from "@/chat/pi/client";

const GATEWAY_MESSAGES_URL = "https://ai-gateway.vercel.sh/v1/messages";
const GATEWAY_CHAT_COMPLETIONS_URL =
  "https://ai-gateway.vercel.sh/v1/chat/completions";
const STUB_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3cAAAAASUVORK5CYII=";

/** Whether a request asks the gateway to generate an image. */
async function isImageGeneration(request: Request): Promise<boolean> {
  if (!request.url.startsWith(GATEWAY_CHAT_COMPLETIONS_URL)) return false;
  const payload = (await request.clone().json()) as { modalities?: unknown };
  return (
    Array.isArray(payload.modalities) && payload.modalities.includes("image")
  );
}

export type GatewayProgress =
  | { type: "model_request" }
  | { type: "tool_request"; name: string; args: unknown };

export interface GatewayObserver {
  /** AI Gateway requests seen since the observer started, by endpoint. */
  requestCounts(): Record<string, number>;
  /** Numeric Messages usage, including side calls made during a fixture call. */
  modelCalls(): Promise<GatewayModelCall[]>;
  setRecording(enabled: boolean): void;
  /** Called for agent model requests and their tool requests. */
  setProgressHook(
    hook: ((progress: GatewayProgress) => Promise<void>) | undefined,
  ): void;
}

/** Estimated cost and provider token counts for one Messages response. */
export interface GatewayModelCall {
  requestIndex: number;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Read only numeric usage from Anthropic Messages SSE, never message content. */
export function readGatewayMessageUsage(
  body: string,
  modelId: string,
): Omit<GatewayModelCall, "requestIndex"> {
  const counters: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
  } = {};
  for (const frame of body.split("\n\n")) {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (!data) continue;
    const event = (() => {
      try {
        return asRecord(JSON.parse(data));
      } catch {
        return undefined;
      }
    })();
    const usage =
      event?.type === "message_start"
        ? asRecord(asRecord(event.message)?.usage)
        : event?.type === "message_delta"
          ? asRecord(event.usage)
          : undefined;
    if (!usage) continue;
    const values = {
      inputTokens: token(usage.input_tokens),
      outputTokens: token(usage.output_tokens),
      cachedInputTokens: token(usage.cache_read_input_tokens),
      cacheCreationTokens: token(usage.cache_creation_input_tokens),
    };
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheCreationTokens",
    ] as const) {
      if (values[field] !== undefined) counters[field] = values[field];
    }
  }
  const call = { modelId, ...counters };
  if (Object.keys(counters).length === 0) return call;
  const model = (() => {
    try {
      return resolveGatewayModel(modelId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unknown AI Gateway model id:")
      ) {
        return undefined;
      }
      throw error;
    }
  })();
  if (!model) return call;
  const costUsd = calculateCost(model, {
    input: counters.inputTokens ?? 0,
    output: counters.outputTokens ?? 0,
    cacheRead: counters.cachedInputTokens ?? 0,
    cacheWrite: counters.cacheCreationTokens ?? 0,
    totalTokens: Object.values(counters).reduce((sum, value) => sum + value, 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  return {
    ...call,
    costUsd: {
      input: costUsd.input,
      output: costUsd.output,
      cacheRead: costUsd.cacheRead,
      cacheWrite: costUsd.cacheWrite,
      total: costUsd.total,
    },
  };
}

interface ToolUseBlock {
  json: string;
  name: string;
}

/** Read tool requests from an Anthropic Messages server-sent event stream. */
function toolRequests(body: string): Array<{ name: string; args: unknown }> {
  const blocks = new Map<number, ToolUseBlock>();
  const requests: Array<{ name: string; args: unknown }> = [];
  for (const frame of body.split("\n\n")) {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (!data) continue;
    let event: {
      content_block?: { name?: string; type?: string };
      delta?: { partial_json?: string; type?: string };
      index?: number;
      type?: string;
    };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const index = event.index ?? -1;
    if (
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use"
    ) {
      blocks.set(index, { json: "", name: event.content_block.name ?? "" });
    } else if (
      event.type === "content_block_delta" &&
      event.delta?.type === "input_json_delta"
    ) {
      const block = blocks.get(index);
      if (block) block.json += event.delta.partial_json ?? "";
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(index);
      if (!block) continue;
      blocks.delete(index);
      requests.push({
        name: block.name,
        args: block.json ? JSON.parse(block.json) : {},
      });
    }
  }
  return requests;
}

/** Install the AI Gateway observer for the current test. */
export function installGatewayObserver(): GatewayObserver {
  const counts: Record<string, number> = {};
  const modelCalls: GatewayModelCall[] = [];
  const observations: Promise<void>[] = [];
  const observationErrors: unknown[] = [];
  let recording = false;
  let progressHook: ((progress: GatewayProgress) => Promise<void>) | undefined;

  mswServer.use(
    http.all("https://ai-gateway.vercel.sh/*", async ({ request }) => {
      const endpoint = new URL(request.url).pathname;
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      if (await isImageGeneration(request)) {
        return HttpResponse.json({
          choices: [
            {
              message: { images: [{ image_url: { url: STUB_PNG_DATA_URL } }] },
            },
          ],
        });
      }
      const hook = progressHook;
      if (
        !request.url.startsWith(GATEWAY_MESSAGES_URL) ||
        (!hook && !recording)
      ) {
        return passthrough();
      }
      const payload = (await request.clone().json()) as {
        model?: unknown;
        tools?: unknown[];
      };
      const toolHook = hook && payload.tools?.length ? hook : undefined;
      if (!toolHook && !recording) {
        return passthrough();
      }
      if (toolHook) await toolHook({ type: "model_request" });
      let response: Response;
      try {
        response = await fetch(bypass(request));
      } catch (error) {
        // The agent aborted the request, for example after a stop.
        if (request.signal.aborted) return Response.error();
        throw error;
      }
      const modelId = typeof payload.model === "string" ? payload.model : "";
      const requestIndex = counts[endpoint];
      if (!toolHook) {
        if (recording && response.ok) {
          observations.push(
            response
              .clone()
              .text()
              .then((body) => {
                modelCalls.push({
                  requestIndex,
                  ...readGatewayMessageUsage(body, modelId),
                });
              })
              .catch((error: unknown) => {
                if (!request.signal.aborted) observationErrors.push(error);
              }),
          );
        }
        return response;
      }
      const body = await response.text();
      if (response.ok) {
        if (recording) {
          modelCalls.push({
            requestIndex,
            ...readGatewayMessageUsage(body, modelId),
          });
        }
        for (const toolRequest of toolRequests(body)) {
          await toolHook({ type: "tool_request", ...toolRequest });
        }
      }
      // fetch() already decoded the body, so drop the encoding headers.
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    }),
  );

  return {
    requestCounts: () => ({ ...counts }),
    async modelCalls() {
      await Promise.all(observations);
      if (observationErrors.length > 0) throw observationErrors[0];
      return [...modelCalls].sort((a, b) => a.requestIndex - b.requestIndex);
    },
    setRecording(enabled) {
      recording = enabled;
    },
    setProgressHook(hook) {
      progressHook = hook;
    },
  };
}
