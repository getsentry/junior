/**
 * Notion page covers for link cards, served through the Junior image proxy.
 * Each read checks the viewer again with their own Notion login.
 */
import type { PluginImageSource } from "@sentry/junior-plugin-api";
import { isNotionPageId, readSignedCoverUrl, readViewerPage } from "./pages.js";

/** Page covers that Notion link cards show. The ref is the page id. */
export const notionCovers: PluginImageSource = {
  async resolve(ctx, ref) {
    if (!isNotionPageId(ref)) return undefined;
    const page = await readViewerPage(ctx, ref);
    const cover = page?.cover;
    if (!page || !cover) return undefined;
    if (cover.type === "external") return { url: cover.url };
    // The unsigned address names the cached image. Only a fetch needs the
    // signed one.
    return {
      url: cover.url,
      location: () => readSignedCoverUrl(ctx, page),
    };
  },
};
