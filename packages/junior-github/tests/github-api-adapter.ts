import type { PluginEgress } from "@sentry/junior-plugin-api";

interface QueuedResponse {
  body?: unknown;
  status?: number;
}

type EgressRequest = Parameters<PluginEgress["fetch"]>[0];

/** Provide queued provider responses and a read-only request outbox. */
export function createGitHubApiTestAdapter(responses: QueuedResponse[]) {
  const pending = [...responses];
  const requests: EgressRequest[] = [];
  return {
    egress: {
      async fetch(request: EgressRequest) {
        requests.push(request);
        const response = pending.shift();
        if (!response) {
          throw new Error("No queued egress response");
        }
        return new Response(
          response.body === undefined
            ? undefined
            : JSON.stringify(response.body),
          { status: response.status ?? 200 },
        );
      },
    } satisfies PluginEgress,
    requests: () => [...requests],
  };
}
