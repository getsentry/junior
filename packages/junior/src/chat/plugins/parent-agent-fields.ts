import type {
  ParentAgentField,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { getRegistrations } from "@/chat/plugins/hooks/registry";
import { basePluginContext } from "@/chat/plugins/hook-context";

type RegisteredParentAgentField = {
  field: ParentAgentField;
  plugin: PluginRegistration;
};

/**
 * Return the fields that plugins add to the parent's entry when a child
 * agent lists its team, by plugin name.
 */
export function parentAgentFields(): Map<string, RegisteredParentAgentField> {
  return new Map(
    getRegistrations().flatMap((plugin) => {
      const field = plugin.hooks?.parentAgentField?.();
      return field ? [[plugin.manifest.name, { field, plugin }] as const] : [];
    }),
  );
}

/**
 * Read the fields that child `conversationId` sees on its parent's entry,
 * by plugin name. A field whose value is undefined is left out.
 */
export async function loadParentAgentFields(args: {
  conversationId: string;
  parentConversationId: string;
}): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    // oxlint-disable-next-line junior/bounded-fan-out -- One call for each registered plugin.
    [...parentAgentFields()].map(async ([name, { field, plugin }]) => {
      const value = await field.load({
        ...basePluginContext(plugin),
        conversationId: args.conversationId,
        parentConversationId: args.parentConversationId,
      });
      return [name, value] as const;
    }),
  );
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}
