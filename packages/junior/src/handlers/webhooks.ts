import {
  createRequestContext,
  logException,
  logWarn,
  withContext,
} from "@/chat/logging";

type WebhookRunner = () => Promise<Response>;

/** Run a platform webhook with shared request log context and error logging. */
export async function handleWebhookRequest(
  request: Request,
  platform: string,
  run: WebhookRunner,
): Promise<Response> {
  const requestContext = createRequestContext(request, { platform });

  return await withContext(requestContext, async () => {
    try {
      const response = await run();

      if (response.status >= 400) {
        let responseBodySnippet: string | undefined;
        try {
          responseBodySnippet = (await response.clone().text()).slice(0, 300);
        } catch {
          responseBodySnippet = undefined;
        }
        logWarn("webhook.response.unsuccessful", {
          "http.response.status_code": response.status,
          "http.request.header.x_slack_request_timestamp":
            request.headers.get("x-slack-request-timestamp") ?? undefined,
          ...(responseBodySnippet
            ? { "app.webhook.response_body": responseBodySnippet }
            : undefined),
        });
      }

      return response;
    } catch (error) {
      logException(error, "webhook.handler.failed");
      throw error;
    }
  });
}
