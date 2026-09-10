import {
  conversationSidebarAnnotationSchema,
  type ConversationAnnotation,
  type ConversationSidebarAnnotation,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";

/** Return plugin-selected sidebar annotations for candidate conversations. */
export async function listConversationSidebarAnnotations(
  conversationIds: string[],
  annotationsByConversation: Map<string, ConversationAnnotation[]>,
): Promise<Record<string, ConversationSidebarAnnotation[]>> {
  const candidates = new Set(conversationIds);
  const selected: Record<string, ConversationSidebarAnnotation[]> = {};
  for (const plugin of getPlugins()) {
    const hook = plugin.hooks?.conversationSidebar;
    if (!hook) continue;
    const annotationsByConversationId = Object.fromEntries(
      conversationIds.flatMap((conversationId) => {
        const annotations = (annotationsByConversation.get(conversationId) ?? []).filter(
          (annotation) => annotation.plugin === plugin.manifest.name,
        );
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
      });
      for (const [conversationId, annotations] of Object.entries(
        result.annotationsByConversationId,
      )) {
        if (!candidates.has(conversationId)) continue;
        const parsed = conversationSidebarAnnotationSchema.array().safeParse(annotations);
        if (!parsed.success || parsed.data.length === 0) continue;
        selected[conversationId] = [
          ...(selected[conversationId] ?? []),
          ...parsed.data,
        ];
      }
    } catch (error) {
      logWarn("plugin.conversation_sidebar.hook.failed", {
        "app.plugin.name": plugin.manifest.name,
        "exception.message": error instanceof Error ? error.message : String(error),
      });
    }
  }
  return selected;
}
