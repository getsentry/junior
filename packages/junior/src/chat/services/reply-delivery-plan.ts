/** Controls terminal reply delivery after any intermediate messages. */
export interface ReplyDeliveryPlan {
  /** False when successful completion intentionally has no terminal text. */
  postThreadText: boolean;
}

/** Resolve whether a completed run still owes visible assistant text. */
export function shouldDeliverReplyText(reply: {
  deliveryPlan?: ReplyDeliveryPlan;
}): boolean {
  return reply.deliveryPlan?.postThreadText !== false;
}
