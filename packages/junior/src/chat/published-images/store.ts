import { createHash } from "node:crypto";
import type { AttachmentStorage } from "@/chat/attachments/storage";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = {
  gif: "image/gif",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type ImageExtension = keyof typeof IMAGE_TYPES;

function detectImageType(data: Buffer): {
  contentType: (typeof IMAGE_TYPES)[ImageExtension];
  extension: ImageExtension;
} | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { contentType: IMAGE_TYPES.png, extension: "png" };
  }
  if (
    data.length >= 3 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255
  ) {
    return { contentType: IMAGE_TYPES.jpg, extension: "jpg" };
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { contentType: IMAGE_TYPES.gif, extension: "gif" };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: IMAGE_TYPES.webp, extension: "webp" };
  }
  return null;
}

function key(filename: string): string {
  return `published-images/${filename}`;
}

/** Publish validated image bytes at a durable, content-addressed public URL. */
export async function publishImage(args: {
  body: Buffer;
  publicBaseUrl: string;
  storage: Pick<AttachmentStorage, "put">;
}): Promise<{
  bytes: number;
  contentType: string;
  url: string;
}> {
  if (args.body.byteLength === 0) {
    throw new Error("image is empty");
  }
  if (args.body.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `image exceeds ${MAX_IMAGE_BYTES} bytes (${args.body.byteLength} bytes)`,
    );
  }
  const imageType = detectImageType(args.body);
  if (!imageType) {
    throw new Error("unsupported image format; use PNG, JPEG, GIF, or WebP");
  }

  const baseUrl = args.publicBaseUrl.trim().replace(/\/+$/, "");
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("public base URL must use HTTP(S)");
  }

  const sha256 = createHash("sha256").update(args.body).digest("hex");
  const filename = `${sha256}.${imageType.extension}`;
  await args.storage.put({
    body: args.body,
    contentType: imageType.contentType,
    key: key(filename),
  });

  return {
    bytes: args.body.byteLength,
    contentType: imageType.contentType,
    url: `${baseUrl}/public/images/${filename}`,
  };
}

/** Open one published image by its content-addressed filename. */
export async function readPublishedImage(args: {
  filename: string;
  storage: Pick<AttachmentStorage, "get">;
}): Promise<{
  body: ReadableStream<Uint8Array>;
  contentType: string;
} | null> {
  const match = args.filename.match(/^([a-f0-9]{64})\.(gif|jpg|png|webp)$/);
  if (!match) return null;

  const extension = match[2] as ImageExtension;
  const body = await args.storage.get(key(args.filename));
  return body ? { body, contentType: IMAGE_TYPES[extension] } : null;
}

/** Build immutable public response headers for one published image. */
export function publishedImageHeaders(contentType: string): Headers {
  return new Headers({
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
}
