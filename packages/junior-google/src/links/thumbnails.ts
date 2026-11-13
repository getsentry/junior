/**
 * Drive file thumbnails for link cards, served through the Junior image
 * proxy. Each read checks the viewer again with the link card rule, and
 * Junior's Google credential goes only to Google's thumbnail host.
 */
import type { PluginImageSource } from "@sentry/junior-plugin-api";
import { readGoogleConfig } from "../config";
import { readGoogleAccessToken } from "../credentials";
import { readViewerFile, thumbnailFileLink } from "./files";

// Drive serves thumbnails of private files from this host, with a size
// suffix such as `=s220`.
const THUMBNAIL_HOST_SUFFIX = ".googleusercontent.com";
const THUMBNAIL_SIZE = "=s640";

/** Drive thumbnails that link cards show. */
export const googleImages: PluginImageSource = {
  async resolve(ctx, ref) {
    const config = readGoogleConfig();
    const link = thumbnailFileLink(ref);
    if (!config || !link) return undefined;
    const file = await readViewerFile(ctx, link, config.allowedDomains);
    const thumbnail = file?.thumbnailLink && URL.parse(file.thumbnailLink);
    if (
      !thumbnail ||
      thumbnail.protocol !== "https:" ||
      !thumbnail.hostname.endsWith(THUMBNAIL_HOST_SUFFIX)
    ) {
      return undefined;
    }
    const accessToken = await readGoogleAccessToken(ctx, config);
    if (!accessToken) return undefined;
    return {
      headers: { authorization: `Bearer ${accessToken}` },
      url: thumbnail.href.replace(/=s\d+$/, THUMBNAIL_SIZE),
    };
  },
};
