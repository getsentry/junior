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
