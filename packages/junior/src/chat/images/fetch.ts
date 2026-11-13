/**
 * Fetch an external image for the image route. Each hop must reach a public
 * address, and only an image of a known type and size comes back.
 */
import type { ImageFetch } from "@sentry/junior-plugin-api";
import { detectImageMediaType } from "@/chat/attachments/media";
import { guardedFetch } from "@/net/guarded-fetch";

/** The largest image that Junior fetches. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

/**
 * One image fetch. `hosts` limits every hop to these hosts and their
 * subdomains, for a core source that trusts only its provider hosts.
 */
export type ImageRequest = ImageFetch & { hosts?: readonly string[] };

/** One fetched image, or why Junior did not take it. */
export type FetchedImage =
  | { bytes: Buffer; contentType: string }
  | { failure: string };

/**
 * Fetch one image through the address guard. Accept only bytes of a known
 * image format.
 */
export async function fetchImage(image: ImageRequest): Promise<FetchedImage> {
  const fetched = await guardedFetch({
    ...image,
    accept: "image/*",
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if ("failure" in fetched) return fetched;
  // The bytes, not the header, set the type. sharp also reads SVG and
  // other formats that Junior does not serve.
  const contentType = detectImageMediaType(fetched.bytes);
  return contentType
    ? { bytes: fetched.bytes, contentType }
    : { failure: "not_an_image" };
}
