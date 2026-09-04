const VISION_IMAGE_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Report whether a media type is a raster image accepted by vision models. */
export function isVisionImageMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized ? VISION_IMAGE_MEDIA_TYPES.has(normalized) : false;
}
