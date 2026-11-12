/**
 * Opaque, signed ids for images that Junior serves. A browser never gets the
 * address of the image, and it cannot ask for an image that Junior did not
 * name.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { readJuniorSecret } from "@/chat/secrets";

const IMAGE_ID_CONTEXT = "junior-image-id";

/** Widths that the image route serves. A fixed set keeps the cache small. */
export const IMAGE_WIDTHS = [64, 128, 320, 640, 1280] as const;

/** One width that the image route serves. */
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

const imageIdPayloadSchema = z
  .object({ ref: z.string().min(1), source: z.string().min(1) })
  .strict();

/** The source that serves an image, and its reference in that source. */
export type ImageRef = z.infer<typeof imageIdPayloadSchema>;

function signature(payload: string): string {
  const secret = readJuniorSecret();
  if (!secret) throw new Error("Cannot sign image ids without JUNIOR_SECRET");
  return createHmac("sha256", secret)
    .update(`${IMAGE_ID_CONTEXT}:${payload}`)
    .digest("base64url");
}

/** Return the signed id of one image. */
export function encodeImageId(image: ImageRef): string {
  const payload = Buffer.from(
    JSON.stringify({ ref: image.ref, source: image.source }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

/** Return the image of a signed id, or nothing when the id is not valid. */
export function decodeImageId(id: string): ImageRef | undefined {
  const [payload, actual, extra] = id.split(".");
  if (!payload || !actual || extra !== undefined) return undefined;
  const expected = Buffer.from(signature(payload));
  const given = Buffer.from(actual);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return undefined;
  }
  try {
    const parsed = imageIdPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the Junior API path of one image at one width. `version` changes
 * the path when the image changes, so a browser can keep each path.
 */
export function imagePath(
  image: ImageRef,
  width: ImageWidth,
  version?: string,
): string {
  const query = new URLSearchParams({ w: String(width) });
  if (version) query.set("v", version);
  return `/api/images/${encodeImageId(image)}?${query}`;
}
