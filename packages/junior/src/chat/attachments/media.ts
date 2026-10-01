export const INPUT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** Report whether a media type is a raster image accepted by vision models. */
export function isVisionImageMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized
    ? INPUT_IMAGE_TYPES.some((type) => type === normalized)
    : false;
}
