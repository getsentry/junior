import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Resolve the Slack channel used by first-class delivery tools. */
export function getSlackDeliveryChannelId(
  context: ToolRuntimeContext,
): string | undefined {
  return context.deliveryChannelId ?? context.channelId;
}
