import {
  handleSlackWebhook,
  type SlackWebhookServices,
} from "@/chat/ingress/slack-webhook";
import { handleWebhookRequest } from "@/handlers/webhooks";
import type { WaitUntilFn } from "@/handlers/types";

/** Handle the production Slack webhook route. */
export async function POST(
  request: Request,
  waitUntil: WaitUntilFn,
  services: SlackWebhookServices,
): Promise<Response> {
  return handleWebhookRequest(request, "slack", () =>
    handleSlackWebhook({
      request,
      services,
      waitUntil,
    }),
  );
}
