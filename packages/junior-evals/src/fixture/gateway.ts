/**
 * AI Gateway observer for the agent test fixture.
 *
 * Every model request goes to the real AI Gateway. This observer only watches
 * agent requests (the ones that offer tools) and holds them while a test
 * reacts. It never changes a model request or its response, and it never
 * writes a model answer. A test can make the provider reject one agent
 * request with `rejectNextModelRequest()`. Two requests are not model requests. Image generation is a third-party image API, so the
 * observer answers it with a 1x1 PNG. `webSearch` is a third-party search
 * provider, so `web.ts` answers it with the results of the test.
 */
import { bypass, http, HttpResponse, passthrough } from "msw";
import { onTestFinished } from "vitest";
import { mswServer } from "@junior-tests/msw/server";
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

let rejectedModelRequests = 0;

/**
 * Make the model provider reject the next model request of the agent in this
 * test, as it does when it blocks a request under its usage policy. Junior
 * does not retry such a request, so the turn fails.
 */
export function rejectNextModelRequest(): void {
  rejectedModelRequests += 1;
  onTestFinished(() => {
    rejectedModelRequests = 0;
  });
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
export function installGatewayObserver(): GatewayObserver {
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
      const hook = progressHook;
      if (
        (!hook && rejectedModelRequests === 0) ||
        !request.url.startsWith(GATEWAY_MESSAGES_URL)
      ) {
        return passthrough();
      }
      const payload = (await request.clone().json()) as { tools?: unknown[] };
      if (!payload.tools?.length) {
        // Titles and other side calls do not offer tools.
        return passthrough();
      }
      if (rejectedModelRequests > 0) {
        rejectedModelRequests -= 1;
        return HttpResponse.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
            },
          },
          { status: 400 },
        );
      }
      if (!hook) return passthrough();
      await hook({ type: "model_request" });
      let response: Response;
      try {
        response = await fetch(bypass(request));
      } catch (error) {
        // The agent aborted the request, for example after a stop.
        if (request.signal.aborted) return Response.error();
        throw error;
      }
      const body = await response.text();
      if (response.ok) {
        for (const toolRequest of toolRequests(body)) {
          await hook({ type: "tool_request", ...toolRequest });
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
    setProgressHook(hook) {
      progressHook = hook;
    },
  };
}
