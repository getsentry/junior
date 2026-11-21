// Port of `estimateImageTokens` in chat/services/token-estimate.ts and of
// chat/services/image-dimensions.ts, for the image attributes of a model
// request span. Keep them in step with the core-drift skill.
import type { ImageContent } from "@earendil-works/pi-ai";

// Characters per token of the size-only estimate: Claude counts about 1.6x
// the tokens of characters / 4. Other models match characters / 4.
const CLAUDE_CHARS_PER_TOKEN = 2.5;
const DEFAULT_CHARS_PER_TOKEN = 4;

// Pi's own size estimate counts each image as this many characters. Images
// without a Claude size estimate keep this basis.
const IMAGE_CHARS = 4_800;

interface ClaudeImageLimits {
  maxEdge: number;
  maxTokens: number;
}

// Resolution tiers from "Resolution and token cost" in
// https://platform.claude.com/docs/en/build-with-claude/vision: Claude 4.7 and
// later models are high-resolution, all other models are standard. New
// models are high-resolution, so only Claude 3 and Claude 4 to 4.6 ids are
// standard.
const CLAUDE_HIGH_RES_IMAGE: ClaudeImageLimits = {
  maxEdge: 2_576,
  maxTokens: 4_784,
};
const CLAUDE_STANDARD_IMAGE: ClaudeImageLimits = {
  maxEdge: 1_568,
  maxTokens: 1_568,
};
const CLAUDE_STANDARD_IMAGE_MODEL =
  /^anthropic\/claude-(?:3\b|[a-z]+-4(?:\.[0-6])?(?![.\d]))/;
const CLAUDE_IMAGE_PATCH_PX = 28;

function charsPerToken(modelId: string): number {
  return modelId.startsWith("anthropic/")
    ? CLAUDE_CHARS_PER_TOKEN
    : DEFAULT_CHARS_PER_TOKEN;
}

function claudeImagePatches(width: number, height: number): number {
  return (
    Math.ceil(width / CLAUDE_IMAGE_PATCH_PX) *
    Math.ceil(height / CLAUDE_IMAGE_PATCH_PX)
  );
}

// Python's round(): the API resolves exact .5 ties toward the even neighbor.
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size Claude resizes an image to before it counts patches. This is the
 * reference implementation in "How Claude resizes and pads images" in
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates:
 * the largest aspect-preserving size whose padded edges and patch count fit
 * the tier limits.
 */
function claudeResizedImageSize(
  width: number,
  height: number,
  limits: ClaudeImageLimits,
): [number, number] {
  const fits = (w: number, h: number) =>
    Math.ceil(w / CLAUDE_IMAGE_PATCH_PX) * CLAUDE_IMAGE_PATCH_PX <=
      limits.maxEdge &&
    Math.ceil(h / CLAUDE_IMAGE_PATCH_PX) * CLAUDE_IMAGE_PATCH_PX <=
      limits.maxEdge &&
    claudeImagePatches(w, h) <= limits.maxTokens;

  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [resizedHeight, resizedWidth] = claudeResizedImageSize(
      height,
      width,
      limits,
    );
    return [resizedWidth, resizedHeight];
  }
  // Binary search on the long edge. `low` always fits, `high` never fits.
  const aspectRatio = width / height;
  const shortEdge = (longEdge: number) =>
    Math.max(roundHalfToEven(longEdge / aspectRatio), 1);
  let low = 1;
  let high = width;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid, shortEdge(mid))) low = mid;
    else high = mid;
  }
  return [low, shortEdge(low)];
}

/**
 * Estimate the tokens of one image for a model, with chat's
 * `estimateMessagesTokens` rule. `sized` is false when the image used the
 * flat per-image value.
 */
export function estimateImageTokens(
  image: ImageContent,
  modelId: string,
): { tokens: number; sized: boolean } {
  const dimensions = modelId.startsWith("anthropic/")
    ? readImageDimensions(image)
    : undefined;
  if (!dimensions) {
    return {
      tokens: Math.ceil(IMAGE_CHARS / charsPerToken(modelId)),
      sized: false,
    };
  }
  const limits = CLAUDE_STANDARD_IMAGE_MODEL.test(modelId)
    ? CLAUDE_STANDARD_IMAGE
    : CLAUDE_HIGH_RES_IMAGE;
  const [width, height] = claudeResizedImageSize(
    dimensions.width,
    dimensions.height,
    limits,
  );
  return { tokens: claudeImagePatches(width, height), sized: true };
}

interface ImageDimensions {
  width: number;
  height: number;
}

// The headers of PNG, GIF, and WebP are in the first bytes. JPEG can put
// large metadata segments before its frame header, so only JPEG decodes more.
const HEADER_BASE64_CHARS = 64 * 1024;

type HeaderReader = (bytes: Buffer) => ImageDimensions | undefined;

const READERS: Record<string, HeaderReader> = {
  "image/png": readPng,
  "image/jpeg": readJpeg,
  "image/gif": readGif,
  "image/webp": readWebp,
};

// Reads the pixel size from an image header without decoding the image.
// Undefined when the type is unknown or the header is not valid.
function readImageDimensions(image: ImageContent): ImageDimensions | undefined {
  const read = READERS[image.mimeType.toLowerCase()];
  if (!read) return undefined;
  const prefix = Buffer.from(
    image.data.slice(0, HEADER_BASE64_CHARS),
    "base64",
  );
  const canReadMore =
    read === readJpeg && image.data.length > HEADER_BASE64_CHARS;
  const dimensions =
    read(prefix) ??
    (canReadMore ? read(Buffer.from(image.data, "base64")) : undefined);
  return dimensions && dimensions.width > 0 && dimensions.height > 0
    ? dimensions
    : undefined;
}

function hasAscii(bytes: Buffer, offset: number, text: string): boolean {
  return bytes.toString("latin1", offset, offset + text.length) === text;
}

// PNG: 8-byte signature, then the IHDR chunk with big-endian width and height.
function readPng(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || !hasAscii(bytes, 12, "IHDR")) {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// GIF: the logical screen size follows the 6-byte signature.
function readGif(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  if (!hasAscii(bytes, 0, "GIF87a") && !hasAscii(bytes, 0, "GIF89a")) {
    return undefined;
  }
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

// JPEG: walk the marker segments to the first start-of-frame (SOFn) segment.
function readJpeg(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // 0xFF fill bytes can come before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // TEM and RSTn markers have no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0-SOF15, except DHT (C4), JPG (C8), and DAC (CC).
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return undefined;
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

// WebP: a RIFF container whose first chunk is VP8 (lossy), VP8L (lossless),
// or VP8X (extended, with the canvas size).
function readWebp(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  if (!hasAscii(bytes, 0, "RIFF") || !hasAscii(bytes, 8, "WEBP")) {
    return undefined;
  }
  if (hasAscii(bytes, 12, "VP8 ")) {
    if (bytes.readUIntBE(23, 3) !== 0x9d012a) return undefined;
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (hasAscii(bytes, 12, "VP8L")) {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (hasAscii(bytes, 12, "VP8X")) {
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }
  return undefined;
}
