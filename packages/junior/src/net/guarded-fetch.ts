/**
 * Fetch an external URL for the server. Each hop must use `https` and reach
 * a public address, the body has a size limit, and the fetch has a time
 * limit.
 */
import https from "node:https";
import net from "node:net";
import { isPublicAddress, publicAddressLookup } from "./public-address";

// External links are untrusted, so allow only a short redirect chain.
const MAX_REDIRECTS = 2;

/** One guarded fetch. */
export interface GuardedRequest {
  accept: string;
  /** Sent only to the origin of `url`, never after a redirect to another. */
  headers?: Record<string, string>;
  /** Limit every hop to these hosts and their subdomains. */
  hosts?: readonly string[] | undefined;
  /** A larger body is a `too_large` failure, unless `truncate` is set. */
  maxBytes: number;
  timeoutMs: number;
  /** Keep the first `maxBytes` of a larger body instead of failing. */
  truncate?: boolean;
  url: string;
  /** Sent on every hop. */
  userAgent?: string;
}

/** The body of the last hop, or why Junior did not take it. */
export type GuardedResponse =
  | { bytes: Buffer; contentType?: string | undefined; url: string }
  | { failure: string };

type Hop =
  | { location: string }
  | { bytes: Buffer; contentType?: string | undefined }
  | { failure: string };

function blockedUrl(url: URL, hosts: readonly string[] | undefined): boolean {
  // Plain `http` can be read or changed on the way, so it is never fetched.
  if (url.protocol !== "https:") return true;
  if (url.username || url.password) return true;
  const host = url.hostname.toLowerCase();
  if (
    hosts &&
    !hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  ) {
    return true;
  }
  // `lookup` runs only for host names, so check an IP address host here.
  const address = host.replace(/^\[|\]$/g, "");
  return net.isIP(address) !== 0 && !isPublicAddress(address);
}

function requestHop(
  url: URL,
  request: GuardedRequest,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Hop> {
  return new Promise((resolve) => {
    const outgoing = https.request(
      url,
      {
        headers: {
          accept: request.accept,
          ...(request.userAgent && { "user-agent": request.userAgent }),
          ...headers,
        },
        // A pooled socket skips `lookup`, so each fetch opens its own socket.
        agent: false,
        lookup: publicAddressLookup,
        method: "GET",
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          resolve({ location });
          return;
        }
        if (status !== 200) {
          response.resume();
          resolve({ failure: `status_${status}` });
          return;
        }
        const contentType = response.headers["content-type"];
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          const room = request.maxBytes - size;
          size += chunk.length;
          if (size <= request.maxBytes) {
            chunks.push(chunk);
            return;
          }
          outgoing.destroy();
          if (!request.truncate) {
            resolve({ failure: "too_large" });
            return;
          }
          chunks.push(chunk.subarray(0, room));
          resolve({ bytes: Buffer.concat(chunks), contentType });
        });
        response.on("end", () =>
          resolve({ bytes: Buffer.concat(chunks), contentType }),
        );
        response.on("error", () => resolve({ failure: "read_failed" }));
      },
    );
    outgoing.on("error", (error: NodeJS.ErrnoException) =>
      resolve({
        failure:
          error.code === "EADDRNOTPUBLIC" ? "blocked_address" : "fetch_failed",
      }),
    );
    outgoing.end();
  });
}

/**
 * Fetch one `https` URL with `GET`. Follow up to 2 redirects, check the
 * address of each hop, and send the headers only to the first origin.
 */
export async function guardedFetch(
  request: GuardedRequest,
): Promise<GuardedResponse> {
  const signal = AbortSignal.timeout(request.timeoutMs);
  const origin = URL.canParse(request.url) ? new URL(request.url).origin : "";
  let current = request.url;
  for (let redirects = 0; ; redirects += 1) {
    if (!URL.canParse(current)) return { failure: "invalid_url" };
    const url = new URL(current);
    if (blockedUrl(url, request.hosts)) return { failure: "blocked_address" };
    const hop = await requestHop(
      url,
      request,
      url.origin === origin ? (request.headers ?? {}) : {},
      signal,
    );
    if ("failure" in hop) return hop;
    if ("location" in hop) {
      if (redirects >= MAX_REDIRECTS) return { failure: "too_many_redirects" };
      if (!URL.canParse(hop.location, url)) return { failure: "invalid_url" };
      current = new URL(hop.location, url).href;
      continue;
    }
    return { ...hop, url: url.href };
  }
}
