export type ReplyDeliveryMode = "thread" | "channel_only";
export type ReplyAckStrategy = "none" | "reaction";
export type ReplyFileDelivery = "none" | "inline" | "followup";

export interface ReplyDeliveryPlan {
  mode: ReplyDeliveryMode;
  ack: ReplyAckStrategy;
  postThreadText: boolean;
  attachFiles: ReplyFileDelivery;
}

export function buildReplyDeliveryPlan(args: {
  explicitChannelPostIntent: boolean;
  channelPostPerformed: boolean;
  reactionPerformed: boolean;
  hasFiles: boolean;
  streamingThreadReply: boolean;
}): ReplyDeliveryPlan {
  const mode: ReplyDeliveryMode =
    args.explicitChannelPostIntent && args.channelPostPerformed ? "channel_only" : "thread";

  let attachFiles: ReplyFileDelivery = "none";
  if (args.hasFiles && mode === "thread") {
    attachFiles = args.streamingThreadReply ? "followup" : "inline";
  }

  return {
    mode,
    ack: args.reactionPerformed ? "reaction" : "none",
    postThreadText: mode === "thread",
    attachFiles
  };
}
