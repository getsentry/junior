import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";

/** Return a fixed route decision from the model service. */
export function mockTurnRouterModel(): void {
  mswServer.use(
    http.post("https://ai-gateway.vercel.sh/v3/ai/language-model", () =>
      HttpResponse.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reasoning_level: "medium",
              profile: "standard",
              confidence: 0.9,
              reason: "Representative integration test request",
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }),
    ),
  );
}
