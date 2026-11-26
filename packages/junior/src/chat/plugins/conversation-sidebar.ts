import { createPluginCache } from "@/chat/plugins/cache";
import {
  conversationSidebarAnnotationSchema,
  type ConversationAnnotation,
  type ConversationSidebarAnnotation,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { createPluginLogger } from "@/chat/plugins/logging";
import { mapBounded } from "@/chat/fan-out";

/** Show native objects by default and let plugins select compact sidebar labels. */
export async function listConversationSidebarAnnotations(
  conversationIds: string[],
  annotationsByConversation: Map<string, ConversationAnnotation[]>,
): Promise<Record<string, ConversationSidebarAnnotation[]>> {
  const candidates = new Set(conversationIds);
  const selected: Record<string, ConversationSidebarAnnotation[]> = {};
  const plugins = getPlugins();
  const customOwners = new Set(
    plugins
      .filter((plugin) => plugin.hooks?.conversationSidebar)
      .map((plugin) => plugin.manifest.name),
  );
  for (const conversationId of conversationIds) {
    const objects = (
      annotationsByConversation.get(conversationId) ?? []
    ).flatMap((annotation) => {
      if (customOwners.has(annotation.plugin) || !annotation.objectType)
        return [];
      return [
        {
          key: annotation.key,
          label: annotation.label,
          objectType:
            annotation.objectType === "item" &&
            annotation.kind === "object" &&
            annotation.facts?.type === "deployment"
              ? ("deployment" as const)
              : annotation.objectType,
          status: annotation.status,
        },
      ];
    });
    if (objects.length) selected[conversationId] = objects;
  }
  // Run the hooks at once, then add their annotations in plugin order.
  const results = await mapBounded(plugins, async (plugin) => {
    const hook = plugin.hooks?.conversationSidebar;
    if (!hook) return [];
    const annotationsByConversationId = Object.fromEntries(
      conversationIds.flatMap((conversationId) => {
        const annotations = (
          annotationsByConversation.get(conversationId) ?? []
        ).filter((annotation) => annotation.plugin === plugin.manifest.name);
        return annotations.length > 0 ? [[conversationId, annotations]] : [];
      }),
    );
    try {
      const result = await hook({
        annotationsByConversationId,
        conversationIds,
        db: getDb(),
        log: createPluginLogger(plugin.manifest.name),
        plugin: { name: plugin.manifest.name },
        cache: createPluginCache(plugin.manifest.name),
      });
      return Object.entries(result.annotationsByConversationId).flatMap(
        ([conversationId, annotations]) => {
          if (!candidates.has(conversationId)) return [];
          const parsed = conversationSidebarAnnotationSchema
            .array()
            .safeParse(annotations);
          return parsed.success && parsed.data.length > 0
            ? [{ annotations: parsed.data, conversationId }]
            : [];
        },
      );
    } catch (error) {
      logWarn("plugin.conversation_sidebar.hook.failed", {
        "app.plugin.name": plugin.manifest.name,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
  for (const { annotations, conversationId } of results.flat()) {
    selected[conversationId] = [
      ...(selected[conversationId] ?? []),
      ...annotations,
    ];
  }
  return selected;
}
