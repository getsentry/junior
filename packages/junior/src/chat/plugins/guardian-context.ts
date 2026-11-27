/**
 * The facts that plugins give Guardian about one call, through their
 * `guardian.context` hooks. Core shows them as one tagged context block.
 */
import type {
  GuardianFactsContext,
  PluginGuardianCall,
} from "@sentry/junior-plugin-api";
import { mapBounded } from "@/chat/fan-out";
import { getPlugins } from "@/chat/plugins/hooks/registry";

/** Most lines, and most characters in all lines, that one call gets. */
const MAX_CONTEXT_LINES = 40;
const MAX_CONTEXT_CHARS = 4_000;
const MAX_LINE_CHARS = 300;

/**
 * Every plugin's general facts and its facts about `call`, each line
 * prefixed with its plugin, within the line and length caps.
 */
export async function pluginGuardianContext(args: {
  call: PluginGuardianCall;
  /** What one plugin's hook may read. */
  ctxFor(plugin: string): GuardianFactsContext;
}): Promise<string[]> {
  const answers = await mapBounded(getPlugins(), async (plugin) => {
    const context = plugin.hooks?.guardian?.context;
    if (!context) return [];
    const ctx = args.ctxFor(plugin.manifest.name);
    const lines = [
      ...(await context(undefined, ctx)),
      ...(await context(args.call, ctx)),
    ];
    return lines.map(
      (line) =>
        `[${plugin.manifest.name}] ${line.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS)}`,
    );
  });
  const kept: string[] = [];
  let chars = 0;
  for (const line of answers.flat()) {
    if (
      kept.length >= MAX_CONTEXT_LINES ||
      chars + line.length > MAX_CONTEXT_CHARS
    ) {
      break;
    }
    kept.push(line);
    chars += line.length;
  }
  return kept;
}
