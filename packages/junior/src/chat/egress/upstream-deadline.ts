// The longest wait for an upstream's response headers. The slowest provider
// reads, such as Sentry event queries, take about 75 seconds. A Git clone
// streams its pack for up to minutes, so the deadline ends at the headers.
const UPSTREAM_HEADERS_DEADLINE_MS = 120_000;

/** An upstream sent no response headers before the egress deadline. */
export class UpstreamDeadlineExceeded extends Error {
  constructor(host: string) {
    super(
      `${host} sent no response within ${UPSTREAM_HEADERS_DEADLINE_MS / 1000} seconds`,
    );
    this.name = "UpstreamDeadlineExceeded";
  }
}

/**
 * Fetch an upstream with a deadline for its response headers, so a stalled
 * provider fails its own request and blocks nothing else.
 */
export async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new UpstreamDeadlineExceeded(url.hostname)),
    UPSTREAM_HEADERS_DEADLINE_MS,
  );
  try {
    return await fetchImpl(url, { ...init, signal: deadline.signal });
  } finally {
    clearTimeout(timer);
  }
}
