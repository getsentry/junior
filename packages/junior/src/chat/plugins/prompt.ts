/** Validated plugin context retained for the current turn. */
export interface PluginTurnContext {
  content: Record<string, unknown>;
  kind: string;
  loadedAtMs: number;
  pluginName: string;
  version: number;
}

export interface PluginPromptContributionContext {
  context?: PluginTurnContext;
  id: string;
  pluginName: string;
  text: string;
}

/** The most characters that the plugin guidance of one prompt may hold. */
export const PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS = 16_000;

/** Name one validated prompt message of a plugin hook. */
export function toPromptContributionContext(args: {
  hookName: "systemPrompt" | "userPrompt";
  index: number;
  message: { text: string };
  pluginName: string;
}): PluginPromptContributionContext {
  return {
    id: `${args.hookName}:${args.index}`,
    pluginName: args.pluginName,
    text: args.message.text,
  };
}
