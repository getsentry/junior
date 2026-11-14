import * as z from "zod";
import type { PluginContext, User } from "./context";
import type { PluginEgress, PluginViewerMcp } from "./tools";

/** How Junior fetches one image. */
export interface ImageFetch {
  /**
   * Request headers, such as the plugin's credential. Junior sends them only
   * to the origin of `url`, not after a redirect to another origin.
   */
  headers?: Record<string, string>;
  /**
   * Return the address to fetch instead of `url`, such as a short-lived
   * signed URL that the plugin reads through egress. Junior calls it only
   * when it fetches the image, not when it serves a cached copy, and sends
   * no `headers` to it. `url` stays the identity of the cached image.
   * Return nothing when the image is gone.
   */
  location?: () => Promise<string | undefined>;
  url: string;
}

/** Trusted host context for one image read. */
export interface ImageSourceContext extends PluginContext {
  /**
   * Provider egress as a system Actor. It gets only credentials that the
   * plugin owns, such as an app, and never the viewer's credentials. Check
   * that the viewer may see the image before you fetch it.
   */
  egress: PluginEgress;
  /** The signed-in person who sees the image. */
  viewer: User;
  /** This plugin's hosted MCP provider as the viewer. See `ObjectLinkContext`. */
  viewerMcp: PluginViewerMcp;
}

/**
 * Images that a plugin serves through the Junior image proxy. `resolve`
 * checks that the viewer may see the image and returns how to fetch it.
 * Return nothing when the viewer cannot see it. Junior checks the address,
 * the type, and the size of each image, and caches it for every viewer.
 * The preview images of the plugin's object annotations come with refs from
 * `encodeObjectImageRef`.
 */
export interface PluginImageSource {
  resolve(
    ctx: ImageSourceContext,
    ref: string,
  ): Promise<ImageFetch | undefined>;
}

const objectImageRefSchema = z
  .object({ key: z.string().min(1), url: z.string().min(1) })
  .strict();

/**
 * One preview image of an object annotation, such as `previewImageUrls` of a
 * code change. `key` is the annotation key, so the plugin can check that the
 * viewer may see that object.
 */
export type ObjectImageRef = z.output<typeof objectImageRefSchema>;

/** Return the image source ref of one object preview image. */
export function encodeObjectImageRef(image: ObjectImageRef): string {
  return JSON.stringify({ key: image.key, url: image.url });
}

/**
 * Return the object preview image of an image source ref, or nothing when
 * the ref names another kind of image.
 */
export function decodeObjectImageRef(ref: string): ObjectImageRef | undefined {
  try {
    const parsed = objectImageRefSchema.safeParse(JSON.parse(ref));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
