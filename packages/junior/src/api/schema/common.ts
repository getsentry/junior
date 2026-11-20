import * as z from "zod";

/** Stable error body returned by Junior-owned REST endpoints. */
export const apiErrorSchema = z.object({ error: z.string().min(1) }).strict();

export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * Carries a content token in both directions. A custom header, not `ETag` /
 * `If-None-Match`: the Vercel CDN answers standard validators only after the
 * function built the response, and then the 304s do not show in app
 * telemetry. A read that sends the token of the copy it holds gets an empty
 * 304 while the content is unchanged.
 */
export const CONTENT_VERSION_HEADER = "x-junior-content-version";
