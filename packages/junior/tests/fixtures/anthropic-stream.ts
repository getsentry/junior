import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export type AnthropicRequest = {
  model: string;
  system?: unknown;
  tools?: unknown;
  messages: Array<{ role: string; content: unknown }>;
};

/** Fake only the HTTP response; Pi still parses output and serializes requests. */
export function mockAnthropicStream(
  modelId: string,
  outputs: Block[][],
): AnthropicRequest[] {
  const requests: AnthropicRequest[] = [];
  mswServer.use(
    http.post(
      "https://ai-gateway.vercel.sh/v1/messages",
      async ({ request }) => {
        const input = (await request.clone().json()) as AnthropicRequest;
        if (input.model !== modelId) return;
        const blocks = outputs[requests.length];
        requests.push(input);
        if (!blocks) throw new Error("Unexpected model request");
        const events: Record<string, unknown>[] = [
          {
            type: "message_start",
            message: {
              id: `message-${requests.length}`,
              type: "message",
              role: "assistant",
              model: input.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
        ];
        blocks.forEach((block, index) => {
          events.push({
            type: "content_block_start",
            index,
            content_block:
              block.type === "tool_use" ? { ...block, input: {} } : block,
          });
          if (block.type === "tool_use") {
            events.push({
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              },
            });
          }
          events.push({ type: "content_block_stop", index });
        });
        events.push(
          {
            type: "message_delta",
            delta: {
              stop_reason: blocks.some((block) => block.type === "tool_use")
                ? "tool_use"
                : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 10 },
          },
          { type: "message_stop" },
        );
        return HttpResponse.text(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    ),
  );
  return requests;
}

/** Omit cache markers on provider blocks, never inside tool arguments or text. */
export function withoutCacheMarkers(
  messages: AnthropicRequest["messages"],
): unknown {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block: Record<string, unknown>) => {
          const { cache_control: _, ...content } = block;
          return content;
        })
      : message.content,
  }));
}
