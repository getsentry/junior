/**
 * Sandbox images for Slides edits.
 *
 * Google fetches the url of a createImage or replaceImage request once,
 * without credentials, and saves that URL with the image. A sandbox file has
 * no such URL. So Junior publishes each sandbox image as a public artifact
 * that stops serving within minutes, and gives Google that URL.
 */
import { posix } from "node:path";
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import type { GoogleToolContext } from "../google-api";

// Request kinds that take an image url. Each request has one key.
const IMAGE_REQUEST_KINDS = ["createImage", "replaceImage"] as const;
// Google Slides takes PNG, JPEG, and GIF. The artifact store also caps the
// size, and Google refuses more than 25 megapixels, which only Google checks.
const IMAGE_SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
] as const;
// Long enough for Google to fetch each image during the batchUpdate. The URL
// stops serving after this, so a deck's saved sourceUrl links to nothing.
const IMAGE_URL_TTL_MS = 5 * 60 * 1000;
const PUBLISH_CONCURRENCY = 4;

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
function sandboxImagePaths(requests: Array<Record<string, unknown>>): string[] {
  return [
    ...new Set(
      requests.flatMap((request) => sandboxImage(request)?.path ?? []),
    ),
  ];
}

/** Read one sandbox image and check that Google Slides takes its format. */
async function readImage(
  ctx: GoogleToolContext,
  path: string,
): Promise<Uint8Array> {
  // Any path in the sandbox works, such as its scratch directory, like the
  // core publishImage tool.
  if (posix.normalize(path) !== path) {
    throw new PluginToolInputError(
      `An image path must be a normalized absolute sandbox path, not ${path}.`,
    );
  }
  const bytes = await ctx.sandbox.readFile(path);
  if (!bytes) {
    throw new PluginToolInputError(
      `No sandbox file at ${path}. Check the path, or create the image first.`,
    );
  }
  const known = IMAGE_SIGNATURES.some((signature) =>
    signature.every((byte, index) => bytes[index] === byte),
  );
  if (!known) {
    throw new PluginToolInputError(
      `${path} is not a PNG, JPEG, or GIF. Convert it to PNG, or use another image.`,
    );
  }
  return bytes;
}

/**
 * Replace each sandbox path used as an image url by the URL of a public
 * artifact that expires within minutes. Call `unpublish` once Google has
 * fetched the images.
 */
export async function publishSandboxImages(
  ctx: GoogleToolContext,
  requests: Array<Record<string, unknown>>,
): Promise<{
  requests: Array<Record<string, unknown>>;
  unpublish: () => Promise<void>;
}> {
  const paths = sandboxImagePaths(requests);
  if (paths.length === 0) return { requests, unpublish: async () => {} };
  const { artifacts } = ctx;
  if (!artifacts) {
    throw new PluginToolInputError(
      "This install cannot publish artifacts, so you cannot insert a sandbox image. Use a public image URL instead.",
    );
  }
  const limit = pLimit(PUBLISH_CONCURRENCY);
  // Check every image before any is published, so a bad path publishes
  // nothing.
  const images = await limit.map(paths, (path) => readImage(ctx, path));
  const urls = new Map<string, string>();
  // Each URL stops serving at its expiry whether or not this runs, so a
  // failed unpublish exposes nothing past the expiry and is not an error.
  const unpublish = async () => {
    await limit.map([...urls.values()], (url) =>
      artifacts.unpublishImage(url).catch(() => undefined),
    );
  };
  // Wait for every publish, even after one fails, so that each published
  // URL is on `urls` before the unpublish starts.
  const published = await limit.map(paths, async (path, index) => {
    try {
      // The checked bytes are the bytes that Google gets.
      const { url } = await artifacts.publishImage({
        body: images[index]!,
        expiresInMs: IMAGE_URL_TTL_MS,
      });
      urls.set(path, url);
      return undefined;
    } catch (error) {
      return { error };
    }
  });
  const failed = published.find((result) => result !== undefined);
  if (failed) {
    await unpublish();
    throw failed.error;
  }
  return {
    requests: requests.map((request) => {
      const image = sandboxImage(request);
      return image
        ? { [image.kind]: { ...image.body, url: urls.get(image.path) } }
        : request;
    }),
    unpublish,
  };
}

/**
 * Return Slides API JSON without the `sourceUrl` of any image.
 *
 * Google saves the url that inserted an image as its `sourceUrl`. For a
 * sandbox image that is a public artifact URL that serves until it expires,
 * so no read returns any image's `sourceUrl` to the model.
 */
export function withoutImageSourceUrls(value: unknown): unknown {
  return strip(value, false);
}

function strip(value: unknown, inImage: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, false));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(inImage && key === "sourceUrl"))
      .map(([key, child]) => [key, strip(child, key === "image")]),
  );
}
