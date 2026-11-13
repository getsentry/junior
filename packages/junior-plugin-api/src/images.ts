import type { PluginContext, User } from "./context";
import type { PluginEgress } from "./tools";

/** How Junior fetches one image. */
export interface ImageFetch {
  /**
   * Request headers, such as the plugin's credential. Junior sends them only
   * to the origin of `url`, not after a redirect to another origin.
   */
  headers?: Record<string, string>;
  url: string;
}

/** Trusted host context for one image read. */
export interface ImageSourceContext extends PluginContext {
  /**
   * Provider egress as a system Actor, as for link cards. It gets only
   * credentials that the plugin owns. Check that the viewer may see the
   * image before you return it.
   */
  egress: PluginEgress;
  /** The signed-in person who sees the image. */
  viewer: User;
}

/**
 * Images that a plugin serves through the Junior image proxy. `resolve`
 * checks that the viewer may see the image and returns how to fetch it.
 * Return nothing when the viewer cannot see it. Junior checks the address,
 * the type, and the size of each image, and caches it for every viewer.
 */
export interface PluginImageSource {
  resolve(
    ctx: ImageSourceContext,
    ref: string,
  ): Promise<ImageFetch | undefined>;
}
