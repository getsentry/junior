/**
 * Serve external images from Junior. Each source checks that the viewer may
 * see an image and names its address. Junior fetches the image once, scales
 * it to the asked width as WebP, and keeps each width in the state cache.
 */
import { createHash } from "node:crypto";
import type { PluginRegistration, User } from "@sentry/junior-plugin-api";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { createPluginEgress } from "@/chat/egress/plugin";
import { readAvatarFetch } from "@/chat/identities/avatar";
import { logWarn } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginCache } from "@/chat/plugins/cache";
import { createPluginLogger } from "@/chat/plugins/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import { fetchImage, type ImageRequest } from "./fetch";
import type { ImageRef, ImageWidth } from "./ids";

const IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Retry a failed image soon, but do not fetch it again on each page load.
const IMAGE_FAILURE_TTL_MS = 5 * 60 * 1000;

/** One image, ready to send to the browser. */
export interface ServedImage {
  contentType: string;
  /** Base64 image bytes, so the state cache can store them as JSON. */
  data: string;
}

type ImageSource = (
  viewer: User,
  ref: string,
) => Promise<ImageRequest | undefined>;

const IMAGE_SYSTEM_ACTOR = { platform: "system", name: "image" } as const;

// Core sources. A plugin source has the name of its plugin.
const CORE_SOURCES: Record<string, ImageSource> = {
  // Every signed-in viewer sees profile photos, as on the People pages.
  avatar: (_viewer, identityId) => readAvatarFetch(getDb(), identityId),
  // Every signed-in viewer sees a public image, such as a link preview.
  public: async (_viewer, url) => ({ url }),
};

function pluginSource(plugin: PluginRegistration): ImageSource | undefined {
  const images = plugin.images;
  if (!images) return undefined;
  const name = plugin.manifest.name;
  return (viewer, ref) =>
    images.resolve(
      {
        cache: createPluginCache(name),
        db: getDb(),
        egress: createPluginEgress({
          credentialContext: credentialContextForActor(IMAGE_SYSTEM_ACTOR),
          // An image is optional. It must never ask anyone to authorize.
          pluginAuth: { async handleAuthRequired() {} },
        }),
        log: createPluginLogger(name),
        plugin: { name },
        viewer,
      },
      ref,
    );
}

function findSource(source: string): ImageSource | undefined {
  if (Object.hasOwn(CORE_SOURCES, source)) return CORE_SOURCES[source];
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === source,
  );
  return plugin && pluginSource(plugin);
}

// Scale the image to the width without making it larger, and keep its
// aspect ratio. A failed conversion keeps the fetched image.
async function scaleImage(
  bytes: Buffer,
  contentType: string,
  width: ImageWidth,
  host: string,
): Promise<ServedImage> {
  try {
    // sharp loads a native library, so load it only when an image is fetched.
    const { default: sharp } = await import("sharp");
    const scaled = await sharp(bytes)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return { contentType: "image/webp", data: scaled.toString("base64") };
  } catch (error) {
    logWarn("image.resize.failed", {
      "server.address": host,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return { contentType, data: bytes.toString("base64") };
  }
}

/**
 * Read one image at one width for a viewer. Return nothing when the source
 * is unknown, the viewer may not see the image, or the fetch fails.
 */
export async function readImage(
  viewer: User,
  image: ImageRef,
  width: ImageWidth,
): Promise<ServedImage | undefined> {
  const source = findSource(image.source);
  const request = source && (await source(viewer, image.ref));
  if (!request || !URL.canParse(request.url)) return undefined;
  const host = new URL(request.url).hostname;
  // The source checked the viewer, so one cached image serves every viewer
  // of that source. Sources fetch with different credentials, so a source
  // never reads the image of another source.
  const key = `image:${image.source}:${width}:${createHash("sha256").update(request.url).digest("hex")}`;
  const served = await createCache(getStateAdapter(), "core").getOrLoad(
    key,
    async () => {
      const fetched = await fetchImage(request);
      if ("failure" in fetched) {
        logWarn("image.fetch.failed", {
          "app.reason": fetched.failure,
          "server.address": host,
        });
        return { value: null, ttlMs: IMAGE_FAILURE_TTL_MS };
      }
      return {
        value: await scaleImage(
          fetched.bytes,
          fetched.contentType,
          width,
          host,
        ),
        ttlMs: IMAGE_CACHE_TTL_MS,
      };
    },
  );
  return served ?? undefined;
}
