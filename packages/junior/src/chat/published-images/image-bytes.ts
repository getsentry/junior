/** Maximum published image size. Matches GitHub's image attachment limit. */
export const MAX_PUBLISHED_IMAGE_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Detect a supported image MIME type from file magic bytes. */
export function detectPublishedImageMimeType(data: Buffer): string | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/** Map a supported image MIME type to a stable file extension. */
export function extensionForPublishedImageMimeType(
  mimeType: string,
): string | undefined {
  return EXTENSION_BY_MIME[mimeType];
}
