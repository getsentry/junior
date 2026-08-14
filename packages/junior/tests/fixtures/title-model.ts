import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";

export type TitleModelRequest = {
  messages?: unknown[];
};

type TitleModelFixtureOptions = {
  onRequest?: (request: TitleModelRequest) => void;
  waitFor?: Promise<unknown>;
};

/** Return fixed title text from the external model edge. */
export function mockTitleModel(
  text: string,
  options: TitleModelFixtureOptions = {},
): void {
  mswServer.use(
    http.post(
      "https://ai-gateway.vercel.sh/v1/messages",
      async ({ request }) => {
        const modelRequest = (await request.json()) as TitleModelRequest;
        options.onRequest?.(modelRequest);
        await options.waitFor;
        const events = [
          {
            type: "message_start",
            message: {
              id: "msg_title_fixture",
              type: "message",
              role: "assistant",
              model: "title-fixture",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        const body = events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join("");
        return HttpResponse.text(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    ),
  );
}
