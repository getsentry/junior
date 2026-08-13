import { createHash } from "node:crypto";
import {
  detectPublishedImageMimeType,
  extensionForPublishedImageMimeType,
  MAX_PUBLISHED_IMAGE_BYTES,
} from "./image-bytes";
import type { PublishedImageStorage } from "./storage";

export interface PublishImageInput {
  /** Optional alt text used only for the returned markdown helper. */
  alt?: string;
  body: Buffer;
  /** Public Junior origin, for example https://junior.example.com. */
  publicBaseUrl: string;
  storage: PublishedImageStorage;
}

export interface PublishedImage {
  bytes: number;
  contentType: string;
  /** Markdown image reference that embeds the public URL. */
  markdown: string;
  /** Object storage key under the published-images prefix. */
  storageKey: string;
  /** Public HTTPS URL anyone with the link can fetch. */
  url: string;
}

export interface ReadPublishedImageInput {
  extension: string;
  sha256: string;
  storage: PublishedImageStorage;
}

export interface ReadPublishedImageResult {
  body: ReadableStream<Uint8Array>;
  bytes: number;
  contentType: string;
  storageKey: string;
}

const PUBLISHED_IMAGE_PREFIX = "published-images";

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("publicBaseUrl is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("publicBaseUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("publicBaseUrl must be an HTTP(S) URL");
  }
  return trimmed;
}

function storageKeyFor(sha256: string, extension: string): string {
  return `${PUBLISHED_IMAGE_PREFIX}/${sha256}.${extension}`;
}

function publicPathFor(sha256: string, extension: string): string {
  return `/public/images/${sha256}.${extension}`;
}

/** Build the durable public URL for one content-addressed published image. */
export function publishedImageUrl(args: {
  extension: string;
  publicBaseUrl: string;
  sha256: string;
}): string {
  return `${normalizePublicBaseUrl(args.publicBaseUrl)}${publicPathFor(args.sha256, args.extension)}`;
}

/** Build markdown that embeds one published image URL. */
export function publishedImageMarkdown(args: {
  alt?: string;
  url: string;
}): string {
  const alt = (args.alt ?? "").replace(/[[\]]/g, "");
  return `![${alt}](${args.url})`;
}

/**
 * Publish image bytes to durable public object storage.
 *
 * The returned URL is public to anyone on the internet who has the link.
 * Identity is content-addressed: the same bytes reuse the same object key and
 * URL. This path does not create conversation attachment rows.
 */
export async function publishImage(
  args: PublishImageInput,
): Promise<PublishedImage> {
  if (args.body.byteLength === 0) {
    throw new Error("image is empty");
  }
  if (args.body.byteLength > MAX_PUBLISHED_IMAGE_BYTES) {
    throw new Error(
      `image exceeds ${MAX_PUBLISHED_IMAGE_BYTES} bytes (${args.body.byteLength} bytes)`,
    );
  }

  const contentType = detectPublishedImageMimeType(args.body);
  if (!contentType) {
    throw new Error("unsupported image format; use PNG, JPEG, GIF, or WebP");
  }
  const extension = extensionForPublishedImageMimeType(contentType);
  if (!extension) {
    throw new Error(`unsupported image content type: ${contentType}`);
  }

  const sha256 = createHash("sha256").update(args.body).digest("hex");
  const storageKey = storageKeyFor(sha256, extension);
  await args.storage.put({
    body: args.body,
    contentType,
    key: storageKey,
  });

  const url = publishedImageUrl({
    extension,
    publicBaseUrl: args.publicBaseUrl,
    sha256,
  });
  return {
    bytes: args.body.byteLength,
    contentType,
    markdown: publishedImageMarkdown({ alt: args.alt, url }),
    storageKey,
    url,
  };
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXTENSION_RE = /^(png|jpg|jpeg|gif|webp)$/;

/** Validate one public image path segment pair. */
export function parsePublishedImagePath(args: {
  extension: string;
  sha256: string;
}): { contentType: string; extension: string; sha256: string } | null {
  const sha256 = args.sha256.trim().toLowerCase();
  const extension = args.extension.trim().toLowerCase();
  if (!SHA256_RE.test(sha256) || !EXTENSION_RE.test(extension)) {
    return null;
  }
  const normalizedExtension = extension === "jpeg" ? "jpg" : extension;
  const contentType =
    normalizedExtension === "jpg"
      ? "image/jpeg"
      : normalizedExtension === "png"
        ? "image/png"
        : normalizedExtension === "gif"
          ? "image/gif"
          : "image/webp";
  return {
    contentType,
    extension: normalizedExtension,
    sha256,
  };
}

/**
 * Read one published image for the unauthenticated public route.
 *
 * Missing or mismatched objects return null so the route can answer 404.
 */
export async function readPublishedImage(
  args: ReadPublishedImageInput,
): Promise<ReadPublishedImageResult | null> {
  const parsed = parsePublishedImagePath({
    extension: args.extension,
    sha256: args.sha256,
  });
  if (!parsed) return null;

  const storageKey = storageKeyFor(parsed.sha256, parsed.extension);
  const body = await args.storage.get(storageKey);
  if (!body) return null;

  // Materialize once so the response can set content-length and keep the body
  // available after the storage stream is consumed.
  const chunks: Buffer[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength === 0) return null;

  const detected = detectPublishedImageMimeType(bytes);
  if (detected !== parsed.contentType) return null;

  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    bytes: bytes.byteLength,
    contentType: parsed.contentType,
    storageKey,
  };
}

/** Build response headers for one public published image. */
export function publishedImageHeaders(args: {
  bytes: number;
  contentType: string;
}): Headers {
  return new Headers({
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(args.bytes),
    "content-type": args.contentType,
    "x-content-type-options": "nosniff",
  });
}
