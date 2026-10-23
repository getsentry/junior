import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";

// Title context is optional. A slow provider must not hold the title back.
const TITLE_CONTEXT_TIMEOUT_MS = 5_000;
const TITLE_CONTEXT_MAX_LINES = 5;
const TITLE_CONTEXT_LINE_MAX_LENGTH = 200;

/**
 * Collect plugin facts, such as linked issue titles, for one new
 * Conversation title. Fails open: a failed plugin adds no facts.
 */
export async function getPluginConversationTitleContext(
  text: string,
): Promise<string[]> {
  const signal = AbortSignal.timeout(TITLE_CONTEXT_TIMEOUT_MS);
  // Stop waiting at the deadline even when a hook ignores the signal.
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  // The deadline can pass after every hook returns.
  timedOut.catch(() => undefined);
  const results = await Promise.all(
    getPlugins().map(async (plugin) => {
      const hook = plugin.hooks?.conversationTitleContext;
      if (!hook) return [];
      try {
        const lines = await Promise.race([
          hook({
            db: getDb(),
            log: createPluginLogger(plugin.manifest.name),
            plugin: { name: plugin.manifest.name },
            signal,
            text,
          }),
          timedOut,
        ]);
        return Array.isArray(lines) ? lines : [];
      } catch (error) {
        logWarn("plugin.conversation_title_context.hook.failed", {
          "app.plugin.name": plugin.manifest.name,
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
  );
  return results
    .flat()
    .filter((line): line is string => typeof line === "string")
    .map((line) =>
      line.replace(/\s+/g, " ").trim().slice(0, TITLE_CONTEXT_LINE_MAX_LENGTH),
    )
    .filter(Boolean)
    .slice(0, TITLE_CONTEXT_MAX_LINES);
}
