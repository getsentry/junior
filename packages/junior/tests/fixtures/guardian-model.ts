import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";

/**
 * Answer each Guardian review on the model service with an allow. Other
 * structured completions get an error, as with no model in tests.
 */
export function mockGuardianAllows(): void {
  mswServer.use(
    http.post(
      /ai-gateway\.vercel\.sh\/.*language-model/,
      async ({ request }) => {
        const body = await request.text();
        if (!body.includes("userAuthorization")) {
          return HttpResponse.json(
            { error: "no model in tests" },
            { status: 400 },
          );
        }
        return HttpResponse.json({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                riskLevel: "low",
                userAuthorization: "high",
                rule: "none",
                reason: "The person asked for this action.",
              }),
            },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        });
      },
    ),
  );
}
