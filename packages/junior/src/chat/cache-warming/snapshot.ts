/**
 * Storage format of the idle-period snapshot: the exact Pi context of the
 * request that ended a Turn, which each idle warmup sends again.
 *
 * Base64 image data does not compress, so one screenshot can make a snapshot
 * too large to store. The data of each image part moves to its own state key,
 * named by its SHA-256 hash, and the snapshot keeps `sha256:<hash>` in its
 * place. Base64 has no `:`, so a reference cannot be image data.
 * The next Turn's snapshot often holds the same images, so it writes the same
 * keys again and refreshes their TTL. A loaded snapshot gets each image's
 * data back at the same JSON position, so the warmup request is the same as
 * the original request and reads its cached prefix. A snapshot with a missing
 * image does not load: a changed request would write a new cache entry.
 * Deleting a snapshot keeps its images, because the next snapshot of the
 * Conversation likely holds them. They expire with their TTL.
 * A snapshot whose images are over their own limit is not stored, so one
 * Conversation cannot keep an unbounded amount of image data in state.
 * Removing its images would change the request, so it would miss the cache.
 */
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  constants as zlibConstants,
  zstdCompress as zstdCompressCallback,
  zstdDecompress as zstdDecompressCallback,
} from "node:zlib";
import type {
  Context,
  ImageContent,
  Message,
  TextContent,
} from "@earendil-works/pi-ai/compat";
import { KEY_PREFIX, type ConnectedState } from "./request";

// Compress off the event loop, so a large snapshot does not delay other work.
const zstdCompress = promisify(zstdCompressCallback);
const zstdDecompress = promisify(zstdDecompressCallback);
// Compute matters more than size here. On sample contexts, level 1 is the
// fastest level that keeps the snapshot within about 10% of level 3's size.
// Negative levels are no faster and much larger.
const SNAPSHOT_ZSTD_PARAMS = {
  params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 },
};
// The limit applies to the snapshot without its image data.
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
// The limit of the base64 data of all images of one snapshot. It holds the
// images of the largest real requests seen. A replay sends only what its
// original request sent, so Anthropic's limits (10 MB per image, 128 MB per
// request) also bound what a snapshot can hold.
const MAX_SNAPSHOT_IMAGE_BYTES = 32 * 1024 * 1024;

const IMAGE_REF_PREFIX = "sha256:";
// Images are user content of the Conversation, so their keys have the same
// scope as its snapshot.
const imageKey = (conversationId: string, sha256: string) =>
  `${KEY_PREFIX}:image:${conversationId}:${sha256}`;

/** Sizes of one snapshot, for telemetry. */
export interface SnapshotSize {
  /** Compressed snapshot, as stored (base64). */
  bytes: number;
  /** Distinct images stored under hash keys. */
  imageCount: number;
  /** Base64 data of those images. */
  imageBytes: number;
}

// Pi keeps image data in `{ type: "image", data, mimeType }` parts of user
// messages and tool results. Assistant messages have no images.
function imageParts(message: Message): ImageContent[] {
  if (message.role === "assistant" || typeof message.content === "string") {
    return [];
  }
  return message.content.filter((part) => part.type === "image");
}

// Keep only the tool fields that Pi sends to the provider. `toRef` replaces
// the data of each image part.
function snapshotContext(
  context: Context,
  toRef: (part: TextContent | ImageContent) => TextContent | ImageContent,
) {
  return {
    ...(context.systemPrompt !== undefined
      ? { systemPrompt: context.systemPrompt }
      : undefined),
    messages: context.messages.map((message) =>
      message.role === "assistant" || typeof message.content === "string"
        ? message
        : { ...message, content: message.content.map(toRef) },
    ),
    ...(context.tools
      ? {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(tool.constrainedSampling !== undefined
              ? { constrainedSampling: tool.constrainedSampling }
              : undefined),
          })),
        }
      : undefined),
  };
}

/**
 * Store the snapshot of a request context with its images under hash keys.
 * Stores nothing and returns a `skipReason` when the snapshot without its
 * images or the images are over their limit. Every key expires after `ttlMs`.
 */
export async function saveSnapshot(
  state: ConnectedState,
  conversationId: string,
  key: string,
  context: Context,
  ttlMs: number,
): Promise<
  SnapshotSize & { skipReason?: "snapshot_too_large" | "images_too_large" }
> {
  const images = new Map<string, string>();
  // Spreading the part keeps `data` at its key position, so the loaded
  // snapshot serializes the same way as the original context.
  const toRef = (part: TextContent | ImageContent) => {
    if (part.type !== "image") return part;
    const sha256 = createHash("sha256").update(part.data).digest("hex");
    images.set(sha256, part.data);
    return { ...part, data: `${IMAGE_REF_PREFIX}${sha256}` };
  };
  // State values are JSON, so the compressed bytes are stored as base64.
  const snapshot = (
    await zstdCompress(
      JSON.stringify(snapshotContext(context, toRef)),
      SNAPSHOT_ZSTD_PARAMS,
    )
  ).toString("base64");
  const size: SnapshotSize = {
    bytes: snapshot.length,
    imageCount: images.size,
    imageBytes: [...images.values()].reduce(
      (sum, data) => sum + data.length,
      0,
    ),
  };
  if (size.bytes > MAX_SNAPSHOT_BYTES) {
    return { ...size, skipReason: "snapshot_too_large" };
  }
  if (size.imageBytes > MAX_SNAPSHOT_IMAGE_BYTES) {
    return { ...size, skipReason: "images_too_large" };
  }
  // Write the images after the snapshot, so they expire after it.
  await state.set(key, snapshot, ttlMs);
  await Promise.all(
    [...images].map(([sha256, data]) =>
      state.set(imageKey(conversationId, sha256), data, ttlMs),
    ),
  );
  return size;
}

/**
 * Load a stored snapshot with its image data. Returns `stopped` when the
 * snapshot is gone and `image_missing` when one of its images is gone.
 */
export async function loadSnapshot(
  state: ConnectedState,
  conversationId: string,
  key: string,
): Promise<Context | "stopped" | "image_missing"> {
  const snapshot = await state.get<string>(key);
  if (!snapshot) {
    return "stopped";
  }
  const context = JSON.parse(
    (await zstdDecompress(Buffer.from(snapshot, "base64"))).toString("utf8"),
  ) as Context;
  for (const part of context.messages.flatMap(imageParts)) {
    if (!part.data.startsWith(IMAGE_REF_PREFIX)) continue;
    const sha256 = part.data.slice(IMAGE_REF_PREFIX.length);
    const data = await state.get<string>(imageKey(conversationId, sha256));
    if (data === null) {
      return "image_missing";
    }
    part.data = data;
  }
  return context;
}
