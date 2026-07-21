import {
  createSlackAdapter,
  type SlackAdapter,
  type SlackAdapterConfig,
} from "@chat-adapter/slack";

/**
 * Create the repository's Slack adapter.
 *
 * Junior used to patch private Slack adapter internals to alter native stream
 * buffering. Visible reply delivery now relies on completed assistant-message
 * thread posts plus status updates, so we keep the documented surface.
 */
export function createJuniorSlackAdapter(
  config?: SlackAdapterConfig,
): SlackAdapter {
  return createSlackAdapter(config);
}
