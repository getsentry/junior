import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";

/** Return a fixed route decision from the decision model service. */
export function mockTurnRouterModel(): void {
  mswServer.use(
    http.post("https://ai-gateway.vercel.sh/v4/ai/decision-model", () =>
      HttpResponse.json({
        answers: {
          profile: {
            type: "choice",
            choice: "standard",
            probabilities: { standard: 0.9 },
          },
          reasoning_level: {
            type: "choice",
            choice: "medium",
            probabilities: { medium: 0.9 },
          },
        },
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    ),
  );
}
