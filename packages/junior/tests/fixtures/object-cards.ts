/**
 * Live card reads, as an Attach, a Turn's card delivery, or a Slack card's
 * details make them. Dashboard reads through `/api/objects` read only the
 * caches.
 */
import type { User } from "@sentry/junior-plugin-api";
import { resolveObjectLinks } from "@/api/objects/resolve";
import { objectLinksReportSchema } from "@/api/schema";
import { mswServer } from "../msw/server";

/** Read the cards of the links for one viewer, with provider reads. */
export async function readLiveCards(viewer: User, urls: readonly string[]) {
  const body = JSON.stringify({
    objects: await resolveObjectLinks(viewer, urls),
  });
  return {
    body,
    objects: objectLinksReportSchema.parse(JSON.parse(body)).objects,
  };
}

/**
 * Record the URL of each outbound HTTP request, such as a provider read,
 * until `stop`. Requests to local services do not count.
 */
export function recordOutboundRequests() {
  const urls: string[] = [];
  const listener = ({ request }: { request: Request }) => {
    const { hostname } = new URL(request.url);
    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
      urls.push(request.url);
    }
  };
  mswServer.events.on("request:start", listener);
  return {
    urls,
    stop: () => mswServer.events.removeListener("request:start", listener),
  };
}
