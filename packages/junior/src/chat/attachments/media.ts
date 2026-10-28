export const INPUT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type InputImageType = (typeof INPUT_IMAGE_TYPES)[number];

/** Leading bytes of each accepted image type. `null` matches any byte. */
const IMAGE_SIGNATURES: readonly {
  mediaType: InputImageType;
  bytes: readonly (number | null)[];
}[] = [
  {
    mediaType: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mediaType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  // "GIF87a" and "GIF89a"
  { mediaType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { mediaType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  // "RIFF", 4-byte file size, "WEBP"
  // prettier-ignore
  { mediaType: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
];

/**
 * Detect an accepted image type from file bytes. Use this instead of a file
 * name or declared content type, which can be wrong.
 */
export function detectImageMediaType(
  data: Uint8Array,
): InputImageType | undefined {
  return IMAGE_SIGNATURES.find(
    ({ bytes }) =>
      data.length >= bytes.length &&
      bytes.every((byte, index) => byte === null || data[index] === byte),
  )?.mediaType;
}

/** Report whether a media type is a raster image accepted by vision models. */
export function isVisionImageMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized
    ? INPUT_IMAGE_TYPES.some((type) => type === normalized)
    : false;
}
