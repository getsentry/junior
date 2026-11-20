import * as z from "zod";

/** Stable error body returned by Junior-owned REST endpoints. */
export const apiErrorSchema = z.object({ error: z.string().min(1) }).strict();

export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * Carries a content token in both directions. A custom header, not `ETag` /
 * `If-None-Match`: the Vercel CDN removes `If-None-Match` before it calls the
 * function, with every `Cache-Control` value, and no setting stops this. The
 * CDN then answers a match with a 304 only after the function built the full
 * response, so the read is not saved and the 304 does not show in app
 * telemetry. A probe deployment confirmed this for `private, no-cache`,
 * `no-cache`, `private, no-store`, `private, max-age=0, must-revalidate`, and
 * no header. See
 * https://vercel.com/docs/manage-cdn-usage#optimizing-fast-origin-transfer.
 * A read that sends the token of the copy it holds gets an empty 304 while
 * the content is unchanged.
 */
export const CONTENT_VERSION_HEADER = "x-junior-content-version";
