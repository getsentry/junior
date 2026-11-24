/**
 * Install settings of the Vimeo plugin. The app passes them to
 * `vimeoPlugin()` in its plugin module, and a bad value stops the app at
 * start instead of failing a tool call later.
 */
import * as z from "zod";
import {
  embedDomainSchema,
  MAX_EMBED_DOMAINS,
  parseFolder,
  type VimeoSettings,
} from "./tool-support/vimeo-api.js";

/** Install settings that the app passes to `vimeoPlugin()`. */
export interface VimeoPluginOptions {
  /**
   * The one folder whose videos the tools may create, change, list, or read,
   * as `/users/<owner id>/projects/<folder id>`.
   */
  folderUri: string;
  /** Hostnames where an upload may be embedded when the call names none. */
  embedDomains?: string[];
}

/** Validate the plugin options, so a bad value fails when the app starts. */
export function vimeoSettings(options: VimeoPluginOptions): VimeoSettings {
  const folder = parseFolder(options.folderUri.trim());
  if (!folder) {
    throw new Error(
      `vimeoPlugin folderUri ${options.folderUri} is not a Vimeo folder URI. Use /users/<owner id>/projects/<folder id>.`,
    );
  }
  const embedDomains = z
    .array(embedDomainSchema)
    .max(MAX_EMBED_DOMAINS)
    .safeParse(options.embedDomains ?? []);
  if (!embedDomains.success) {
    throw new Error(
      `vimeoPlugin embedDomains must be at most ${MAX_EMBED_DOMAINS} bare hostnames, such as www.example.com.`,
    );
  }
  return { folder, embedDomains: embedDomains.data };
}
