import { promptMessageSchema } from "@sentry/junior-plugin-api";
import { getRegistrations } from "@/chat/plugins/agent-hooks";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { runPluginHooksAtOnce } from "@/chat/plugins/hook-runner";
import type { PluginPromptContributionContext } from "@/chat/plugins/prompt";
import { renderPluginContextSection } from "@/chat/prompt";

/**
 * Append the `compactionContext` contributions of plugins to the text of a
 * compaction summary, so their state survives the History replacement. A
 * hook that fails fails the compaction: a summary without that state would
 * lose it.
 */
export async function appendPluginCompactionContext(
  summaryText: string,
  conversationId: string,
): Promise<string> {
  const outcomes = await runPluginHooksAtOnce(getRegistrations(), (plugin) => {
    const hook = plugin.hooks?.compactionContext;
    return (
      hook && (() => hook({ ...basePluginContext(plugin), conversationId }))
    );
  });
  const contributions: PluginPromptContributionContext[] = [];
  for (const outcome of outcomes) {
    if ("error" in outcome) throw outcome.error;
    const pluginName = outcome.plugin.manifest.name;
    for (const [index, value] of (outcome.value ?? []).entries()) {
      contributions.push({
        id: `compactionContext:${index}`,
        pluginName,
        text: promptMessageSchema.parse(value).text,
      });
    }
  }
  const section = renderPluginContextSection(contributions);
  return section ? `${summaryText}\n\n${section}` : summaryText;
}
