export type ReplyDeliveryMode = "thread" | "channel_only";
export type ReplyFileDelivery = "none" | "inline" | "followup";

export interface ReplyDeliveryPlan {
  mode: ReplyDeliveryMode;
  postThreadText: boolean;
  attachFiles: ReplyFileDelivery;
}

/** Determine how a normal finalized reply should be delivered. */
export function buildReplyDeliveryPlan(args: {
  hasFiles: boolean;
}): ReplyDeliveryPlan {
  return {
    mode: "thread",
    postThreadText: true,
    attachFiles: args.hasFiles ? "inline" : "none",
  };
}
