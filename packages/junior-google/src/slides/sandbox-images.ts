/**
 * Sandbox images for Slides edits.
 *
 * Google fetches the url of a createImage or replaceImage request once,
 * without credentials, and saves that URL with the image. A sandbox file has
 * no such URL. So Junior keeps a private copy of each sandbox image and gives
 * Google a download URL that stops working within minutes.
 */
import { posix } from "node:path";
import {
  PluginToolInputError,
  type PluginDownloadUrl,
  type PluginDownloadUrls,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import type { GoogleToolContext } from "../google-api";

// Request kinds that take an image url. Each request has one key.
const IMAGE_REQUEST_KINDS = ["createImage", "replaceImage"] as const;
// Google takes images under 50 MB. It also refuses more than 25 megapixels,
// which only Google checks.
const MAX_IMAGE_BYTES = 50_000_000;
// Google refuses an image url longer than 2 KB.
const MAX_IMAGE_URL_LENGTH = 2048;
const IMAGE_SIGNATURES = [
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mimeType: "image/png",
  },
  { bytes: [0xff, 0xd8, 0xff], mimeType: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mimeType: "image/gif" },
] as const;
const UPLOAD_CONCURRENCY = 4;

const imageRequestSchema = z.object({ url: z.string() }).loose();

/** Return the image request in `request` when its url is a sandbox path. */
function sandboxImage(request: Record<string, unknown>) {
  for (const kind of IMAGE_REQUEST_KINDS) {
    const body = imageRequestSchema.safeParse(request[kind]).data;
    if (body?.url.startsWith("/")) return { body, kind, path: body.url };
  }
  return undefined;
}

/** Return each sandbox path that the requests use as an image url, once. */
export function sandboxImagePaths(
  requests: Array<Record<string, unknown>>,
): string[] {
  return [
    ...new Set(
      requests.flatMap((request) => sandboxImage(request)?.path ?? []),
    ),
  ];
}

/**
 * Read and check one sandbox image, then make its download URL. The URL goes
 * on `links` as soon as it exists, so the caller deletes its copy even when a
 * later check fails.
 */
async function imageUrl(
  ctx: GoogleToolContext,
  downloadUrls: PluginDownloadUrls,
  path: string,
  links: PluginDownloadUrl[],
): Promise<[string, string]> {
  const bytes = await ctx.sandbox.readFile(path);
  if (!bytes) {
    throw new PluginToolInputError(`No sandbox file at ${path}.`);
  }
  if (bytes.byteLength >= MAX_IMAGE_BYTES) {
    throw new PluginToolInputError(
      `${path} is ${Math.ceil(bytes.byteLength / 1_000_000)} MB. Google Slides takes images under 50 MB.`,
    );
  }
  const mimeType = IMAGE_SIGNATURES.find(({ bytes: signature }) =>
    signature.every((byte, index) => bytes[index] === byte),
  )?.mimeType;
  if (!mimeType) {
    throw new PluginToolInputError(`${path} is not a PNG, JPEG, or GIF.`);
  }
  // The checked bytes are the bytes that Google gets.
  const link = await downloadUrls.create({
    body: bytes,
    contentType: mimeType,
  });
  links.push(link);
  if (link.url.length > MAX_IMAGE_URL_LENGTH) {
    throw new PluginToolInputError(
      `The download URL for ${path} is longer than the 2 KB that Google Slides takes. Use a public image URL instead.`,
    );
  }
  return [path, link.url];
}

/**
 * Run `apply` with the requests, after each sandbox path used as an image
 * url is replaced by a short-lived download URL of a private copy.
 */
export async function withSandboxImages<T>(
  ctx: GoogleToolContext,
  requests: Array<Record<string, unknown>>,
  apply: (requests: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const paths = sandboxImagePaths(requests);
  if (paths.length === 0) return await apply(requests);
  for (const path of paths) {
    if (
      posix.normalize(path) !== path ||
      !path.startsWith(`${ctx.sandbox.root}/`)
    ) {
      throw new PluginToolInputError(
        `An image path must be a normalized absolute path under ${ctx.sandbox.root}, not ${path}.`,
      );
    }
  }
  const { downloadUrls } = ctx;
  if (!downloadUrls) {
    throw new PluginToolInputError(
      "The storage of this install cannot sign short-lived download URLs, so you cannot insert a sandbox image. Use a public image URL instead.",
    );
  }

  const links: PluginDownloadUrl[] = [];
  try {
    // Wait for every image, even after one fails, so that each copy is on
    // `links` before the deletes start.
    const made = await pLimit(UPLOAD_CONCURRENCY).map(paths, (path) =>
      imageUrl(ctx, downloadUrls, path, links).then(
        (entry) => ({ entry }),
        (error: unknown) => ({ error }),
      ),
    );
    const failed = made.find((result) => "error" in result);
    if (failed) throw failed.error;
    const urls = new Map(
      made.flatMap((result) => ("entry" in result ? [result.entry] : [])),
    );
    return await apply(
      requests.map((request) => {
        const image = sandboxImage(request);
        return image
          ? { [image.kind]: { ...image.body, url: urls.get(image.path) } }
          : request;
      }),
    );
  } finally {
    // Google has fetched each image by the time batchUpdate returns. Each URL
    // stops working at its expiry whether or not its copy is deleted, so a
    // failed delete exposes nothing and is not an error for the edit.
    await pLimit(UPLOAD_CONCURRENCY).map(links, (link) =>
      link.delete().catch(() => undefined),
    );
  }
}
