/**
 * Sentry API calls for link cards, through `@sentry/api`.
 *
 * Each call goes through one Junior egress, so the host picks the token:
 * Junior's org read token, or the viewer's own. The client keeps no
 * response cache, so one viewer's data never serves another.
 */
import {
  createSentryClient,
  type SdkResult,
  type SentryClient,
} from "@sentry/api";
import type { PluginEgress } from "@sentry/junior-plugin-api";

/** Return a Sentry API client that sends one operation through `egress`. */
export function sentryApi(
  egress: PluginEgress,
  origin: string,
  operation: string,
): SentryClient {
  return createSentryClient({
    baseUrl: origin,
    fetch: (input, init) =>
      egress.fetch({
        operation,
        provider: "sentry",
        request: new Request(input, init),
      }),
  });
}

/**
 * Return the data of a Sentry API result, or nothing when Sentry answers
 * with one of the `refused` statuses. Throws for other failures, naming
 * `what` failed.
 */
export function sentryData<T>(
  result: SdkResult<T>,
  refused: readonly number[],
  what: string,
): T | null {
  if (!("error" in result)) return result.data;
  const status = result.response?.status;
  if (status === undefined) throw result.error;
  if (refused.includes(status)) return null;
  throw new Error(`Sentry ${what} failed with HTTP ${status}`, {
    cause: result.error,
  });
}
