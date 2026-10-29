const PLUGIN_DENIAL_INSTRUCTIONS = [
  "This action was blocked by policy and was not executed.",
  "Do not retry it or reach the same result through a workaround or another tool.",
  "Stop and explain what was blocked and why.",
].join("\n");

/** Expected tool failure when a plugin hook refuses a tool call by policy. */
export class PluginToolDeniedError extends Error {
  constructor(reason: string) {
    super(`${PLUGIN_DENIAL_INSTRUCTIONS}\nReason: ${reason}`);
    this.name = "PluginToolDeniedError";
  }
}
