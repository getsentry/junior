/**
 * Runtime ownership for plugin user pages.
 *
 * This module joins registered readers with the authenticated viewer and
 * validates every plugin response before it reaches the dashboard.
 */
import {
  pluginUserPageContentSchema,
  pluginUserPageLinksSchema,
  type PluginUserPageContent,
  type PluginUserPageLink,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { readViewerActors } from "@/chat/plugins/viewer-actors";
import { getPlugins } from "@/chat/plugins/agent-hooks";

/** List safe navigation metadata for registered plugin user pages. */
export function readPluginUserPageLinks(): PluginUserPageLink[] {
  return pluginUserPageLinksSchema.parse(
    getPlugins().flatMap((plugin) =>
      (plugin.userPages ?? []).map((page) => ({
        description: page.description,
        id: page.id,
        label: page.label,
        pluginDisplayName: plugin.manifest.displayName,
        pluginName: plugin.manifest.name,
      })),
    ),
  );
}

/** Read one registered plugin user page for the authenticated viewer. */
export async function readPluginUserPage(input: {
  email: string;
  pageId: string;
  pluginName: string;
}): Promise<PluginUserPageContent | undefined> {
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === input.pluginName,
  );
  const page = plugin?.userPages?.find(
    (candidate) => candidate.id === input.pageId,
  );
  if (!plugin || !page) return undefined;

  return pluginUserPageContentSchema.parse(
    await page.read({
      db: getDb(),
      log: createPluginLogger(plugin.manifest.name),
      plugin: { name: plugin.manifest.name },
      viewer: {
        actors: await readViewerActors(input.email),
        email: input.email,
      },
    }),
  );
}
