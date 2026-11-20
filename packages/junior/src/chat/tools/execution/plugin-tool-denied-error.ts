const NOT_RUN_LINE = "This action was blocked by policy and was not executed.";
const RAN_LINE =
  "This action ran, but policy rejected its result. Its changes may still be in place.";
const PLUGIN_DENIAL_INSTRUCTIONS = [
  "Do not retry it or reach the same result through a workaround or another tool.",
  "Stop and explain what was blocked and why.",
].join("\n");

/** Expected tool failure when a plugin hook refuses a tool call by policy. */
export class PluginToolDeniedError extends Error {
  /** `ran` is true when an after-execution hook rejected the result. */
  constructor(reason: string, options: { ran?: boolean } = {}) {
    super(
      `${options.ran ? RAN_LINE : NOT_RUN_LINE}\n${PLUGIN_DENIAL_INSTRUCTIONS}\nReason: ${reason}`,
    );
    this.name = "PluginToolDeniedError";
  }
}
