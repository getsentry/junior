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
  type PluginUserPageInput,
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
        navigation: page.navigation ?? "profile",
        pluginDisplayName: plugin.manifest.displayName,
        pluginName: plugin.manifest.name,
      })),
    ),
  );
}

function actionBelongsToPlugin(href: string, pluginName: string): boolean {
  const parsed = new URL(href, "http://junior.local");
  return (
    parsed.origin === "http://junior.local" &&
    parsed.pathname === href &&
    parsed.pathname.startsWith(`/api/plugins/${pluginName}/`) &&
    !parsed.search &&
    !parsed.hash
  );
}

/** Read one registered plugin user page for the authenticated viewer. */
export async function readPluginUserPage(input: {
  email: string;
  pageId: string;
  pluginName: string;
  query: PluginUserPageInput;
}): Promise<PluginUserPageContent | undefined> {
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === input.pluginName,
  );
  const page = plugin?.userPages?.find(
    (candidate) => candidate.id === input.pageId,
  );
  if (!plugin || !page) return undefined;

  const content = pluginUserPageContentSchema.parse(
    await page.read(
      {
        db: getDb(),
        log: createPluginLogger(plugin.manifest.name),
        plugin: { name: plugin.manifest.name },
        viewer: {
          actors: await readViewerActors(input.email),
          email: input.email,
        },
      },
      input.query,
    ),
  );
  if (
    content.records.some((record) =>
      record.actions?.some(
        (action) => !actionBelongsToPlugin(action.href, plugin.manifest.name),
      ),
    )
  ) {
    throw new Error(
      `Plugin user page "${plugin.manifest.name}/${page.id}" returned an action outside its API namespace.`,
    );
  }
  return content;
}
