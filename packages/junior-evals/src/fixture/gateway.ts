/**
 * AI Gateway observer for the agent test fixture.
 *
 * Model requests go to the real AI Gateway, or to `model-replay.ts` when
 * replay is on. This observer watches agent requests (the ones that offer
 * tools) and holds them while a test reacts. It never changes a model request
 * or its response. Two requests are not model requests. Image generation is a
 * third-party image API, so the observer answers it with a 1x1 PNG. `webSearch` is a third-party search
 * provider, so `web.ts` answers it with the results of the test.
 */
import { http, HttpResponse, passthrough } from "msw";
import { mswServer } from "@junior-tests/msw/server";
import type { ModelReplay, ModelResponse } from "./model-replay";
import { answerWebSearch } from "./web";

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
  /** Called for agent model requests and their tool requests. */
  setProgressHook(
    hook: ((progress: GatewayProgress) => Promise<void>) | undefined,
  ): void;
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
export function installGatewayObserver(replay: ModelReplay): GatewayObserver {
  const counts: Record<string, number> = {};
  let progressHook: ((progress: GatewayProgress) => Promise<void>) | undefined;

  mswServer.use(
    http.all("https://ai-gateway.vercel.sh/*", async ({ request }) => {
      const endpoint = new URL(request.url).pathname;
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      const searchResponse = await answerWebSearch(request);
      if (searchResponse) return searchResponse;
      if (await isImageGeneration(request)) {
        return HttpResponse.json({
          choices: [
            {
              message: { images: [{ image_url: { url: STUB_PNG_DATA_URL } }] },
            },
          ],
        });
      }
      if (request.method !== "POST") return passthrough();
      const hook = progressHook;
      // Titles and other side calls do not offer tools.
      const agentRequest =
        hook !== undefined &&
        request.url.startsWith(GATEWAY_MESSAGES_URL) &&
        Boolean(
          ((await request.clone().json()) as { tools?: unknown[] }).tools
            ?.length,
        );
      // Without replay, only agent requests need the response body.
      if (!agentRequest && !replay.enabled) return passthrough();
      if (agentRequest) await hook({ type: "model_request" });
      let response: ModelResponse;
      try {
        response = await replay.send(request);
      } catch (error) {
        // The agent aborted the request, for example after a stop.
        if (request.signal.aborted) return Response.error();
        throw error;
      }
      if (agentRequest && response.status >= 200 && response.status < 300) {
        for (const toolRequest of toolRequests(response.body)) {
          await hook({ type: "tool_request", ...toolRequest });
        }
      }
      return new Response(response.body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }),
  );

  return {
    requestCounts: () => ({ ...counts }),
    setProgressHook(hook) {
      progressHook = hook;
    },
  };
}
