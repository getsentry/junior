import { createHmac } from "node:crypto";

/** Build a rollout-compatible signed dispatch callback request. */
export function createSignedDispatchCallbackRequest(
  payload: { expectedVersion: number; id: string },
  options?: { secret?: string; signature?: string },
): Request {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const digest = createHmac("sha256", options?.secret ?? "dispatch-secret")
    .update(`junior.agent_dispatch.v1:${timestamp}:${body}`)
    .digest("hex");
  return new Request("https://junior.example.com/api/internal/agent-dispatch", {
    method: "POST",
    headers: {
      "x-junior-dispatch-signature": options?.signature ?? `v1=${digest}`,
      "x-junior-dispatch-timestamp": timestamp,
    },
    body,
  });
}
