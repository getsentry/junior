export type ReplyDeliveryMode = "thread" | "channel_only";

export interface ReplyDeliveryPlan {
  mode: ReplyDeliveryMode;
  postThreadText: boolean;
}
