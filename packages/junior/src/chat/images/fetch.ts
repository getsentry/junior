/**
 * Fetch an external image for the image route. Each hop must reach a public
 * address, and only an image of a known type and size comes back.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { ImageFetch } from "@sentry/junior-plugin-api";
import { detectImageMediaType } from "@/chat/attachments/media";
import { isPublicAddress, publicAddressLookup } from "@/net/public-address";

/** The largest image that Junior fetches. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

/**
 * One image fetch. `hosts` limits every hop to these hosts and their
 * subdomains, for a core source that trusts only its provider hosts.
 */
export type ImageRequest = ImageFetch & { hosts?: readonly string[] };

/** One fetched image, or why Junior did not take it. */
export type FetchedImage =
  | { bytes: Buffer; contentType: string }
  | { failure: string };

type Hop = { location: string } | { bytes: Buffer } | { failure: string };

function blockedUrl(url: URL, hosts: readonly string[] | undefined): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
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
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Hop> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const request = client.request(
      url,
      {
        headers: { accept: "image/*", ...headers },
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
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            request.destroy();
            resolve({ failure: "too_large" });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks) }));
        response.on("error", () => resolve({ failure: "read_failed" }));
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) =>
      resolve({
        failure:
          error.code === "EADDRNOTPUBLIC" ? "blocked_address" : "fetch_failed",
      }),
    );
    request.end();
  });
}

/**
 * Fetch one image. Follow up to 3 redirects, and send the headers only to
 * the first origin. Accept only bytes of a known image format.
 */
export async function fetchImage(image: ImageRequest): Promise<FetchedImage> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const origin = URL.canParse(image.url) ? new URL(image.url).origin : "";
  let current = image.url;
  for (let redirects = 0; ; redirects += 1) {
    if (!URL.canParse(current)) return { failure: "invalid_url" };
    const url = new URL(current);
    if (blockedUrl(url, image.hosts)) return { failure: "blocked_address" };
    const hop = await requestHop(
      url,
      url.origin === origin ? (image.headers ?? {}) : {},
      signal,
    );
    if ("failure" in hop) return hop;
    if ("location" in hop) {
      if (redirects >= MAX_REDIRECTS) return { failure: "too_many_redirects" };
      if (!URL.canParse(hop.location, url)) return { failure: "invalid_url" };
      current = new URL(hop.location, url).href;
      continue;
    }
    // The bytes, not the header, set the type. sharp also reads SVG and
    // other formats that Junior does not serve.
    const contentType = detectImageMediaType(hop.bytes);
    return contentType
      ? { bytes: hop.bytes, contentType }
      : { failure: "not_an_image" };
  }
}
