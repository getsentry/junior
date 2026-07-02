export type ReplyDeliveryMode = "thread" | "channel_only";
export type ReplyFileDelivery = "none" | "inline" | "followup";

export interface ReplyDeliveryPlan {
  mode: ReplyDeliveryMode;
  postThreadText: boolean;
  attachFiles: ReplyFileDelivery;
}

/** Determine how a reply should be delivered (thread vs channel, file handling). */
export function buildReplyDeliveryPlan(args: {
  explicitChannelPostIntent: boolean;
  channelPostPerformed: boolean;
  hasFiles: boolean;
}): ReplyDeliveryPlan {
  const mode: ReplyDeliveryMode =
    args.explicitChannelPostIntent && args.channelPostPerformed
      ? "channel_only"
      : "thread";

  let attachFiles: ReplyFileDelivery = "none";
  if (args.hasFiles && mode === "thread") {
    attachFiles = "inline";
  }

  return {
    mode,
    postThreadText: mode === "thread",
    attachFiles,
  };
}
