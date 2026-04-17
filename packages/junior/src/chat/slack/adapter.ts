import {
  createSlackAdapter,
  type SlackAdapter,
  type SlackAdapterConfig,
} from "@chat-adapter/slack";

/**
 * Create the repository's Slack adapter.
 *
 * Junior used to patch private Slack adapter internals to alter native stream
 * buffering. Visible reply delivery now relies on finalized thread posts plus
 * assistant status updates, so we keep the adapter on the documented surface.
 */
export function createJuniorSlackAdapter(
  config?: SlackAdapterConfig,
): SlackAdapter {
  return createSlackAdapter(config);
}
