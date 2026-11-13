import { createHmac, randomUUID } from "node:crypto";
import type { AutomationInput, Input } from "./inputs";

/** Whether an input starts work from an automation route. */
export function isAutomationInput(input: Input): input is AutomationInput {
  return input.kind === "heartbeat" || input.kind === "github_webhook";
}

/** The production request for an automation input. */
export function automationRequest(input: AutomationInput): Request {
  if (input.kind === "heartbeat") {
    return new Request("http://junior.test/api/internal/heartbeat", {
      headers: { authorization: `Bearer ${heartbeatSecret()}` },
    });
  }
  const body = JSON.stringify({
    ...input.payload,
    installation: { id: Number(requiredEnv("GITHUB_INSTALLATION_ID")) },
  });
  const signature = createHmac("sha256", requiredEnv("GITHUB_WEBHOOK_SECRET"))
    .update(body)
    .digest("hex");
  return new Request("http://junior.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": randomUUID(),
      "x-github-event": input.event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`The agent test fixture needs ${name}`);
  return value;
}

/** The secret of the heartbeat route, read as the route reads it. */
function heartbeatSecret(): string {
  const secret =
    process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim();
  if (!secret) {
    throw new Error("The agent test fixture needs JUNIOR_SCHEDULER_SECRET");
  }
  return secret;
}
