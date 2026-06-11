import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Resolve the Slack channel used by first-class delivery tools. */
export function getSlackDeliveryChannelId(
  context: ToolRuntimeContext,
): string | undefined {
  if (context.deliveryChannelId) {
    return context.deliveryChannelId;
  }
  return context.destination.platform === "slack"
    ? context.destination.channelId
    : context.channelId;
}
