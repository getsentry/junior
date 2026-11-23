/**
 * Vimeo plugin runtime boundary.
 *
 * The tools upload sandbox videos into a Vimeo folder as private videos,
 * replace their files and thumbnails, and read their state. They run on the
 * host and send files with tus in chunks, so sandbox request limits do not
 * apply. Junior uses only the plugin's service account: an admin connects
 * one shared Vimeo account, and people never connect their own. Junior adds
 * its token to the plugin's API calls on the host.
 *
 * Every upload is private when Vimeo creates it: hidden from vimeo.com or
 * unlisted, embeddable only on allowed domains, and not downloadable. No
 * tool can make a video public.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { VIMEO_OPERATIONS } from "./tool-support/vimeo-api.js";
import { vimeoListFolderTool } from "./tools/list-folder.js";
import { vimeoReplaceFileTool } from "./tools/replace-file.js";
import { vimeoSetThumbnailTool } from "./tools/set-thumbnail.js";
import { vimeoStatusTool } from "./tools/status.js";
import { vimeoUploadTool } from "./tools/upload.js";

/** Register the Vimeo upload, file, thumbnail, status, and folder tools. */
export function vimeoPlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-vimeo",
    manifest: {
      name: "vimeo",
      displayName: "Vimeo",
      description:
        "Upload private videos to a Vimeo folder, replace their files and thumbnails, and check their processing",
      credentials: {
        type: "oauth-bearer",
        domains: ["api.vimeo.com"],
      },
      oauth: {
        clientIdEnv: "VIMEO_CLIENT_ID",
        clientSecretEnv: "VIMEO_CLIENT_SECRET",
        authorizeEndpoint: "https://api.vimeo.com/oauth/authorize",
        tokenEndpoint: "https://api.vimeo.com/oauth/access_token",
        scope: "public private upload edit",
        tokenAuthMethod: "basic",
      },
      accounts: {
        userOAuth: false,
        serviceAccount: { operations: Object.values(VIMEO_OPERATIONS) },
      },
      envVars: {
        VIMEO_CLIENT_ID: {},
        VIMEO_CLIENT_SECRET: {},
        VIMEO_EMBED_DOMAINS: {},
        VIMEO_FOLDER_URI: {},
      },
    },
    hooks: {
      tools() {
        return {
          upload: vimeoUploadTool,
          replaceFile: vimeoReplaceFileTool,
          setThumbnail: vimeoSetThumbnailTool,
          status: vimeoStatusTool,
          listFolder: vimeoListFolderTool,
        };
      },
    },
  });
}
