import type { ReplyFileDelivery } from "@/chat/delivery/plan";
import type { AssistantReply } from "@/chat/respond";

export function resolveReplyDelivery(args: {
  reply: AssistantReply;
  hasStreamedThreadReply: boolean;
}): {
  shouldPostThreadReply: boolean;
  attachFiles: ReplyFileDelivery;
} {
  const replyHasFiles = Boolean(args.reply.files && args.reply.files.length > 0);
  const deliveryPlan = args.reply.deliveryPlan ?? {
    mode: args.reply.deliveryMode ?? "thread",
    ack: args.reply.ackStrategy ?? "none",
    postThreadText: (args.reply.deliveryMode ?? "thread") !== "channel_only",
    attachFiles: replyHasFiles ? (args.hasStreamedThreadReply ? "followup" : "inline") : "none"
  };

  let attachFiles = deliveryPlan.attachFiles;
  if (attachFiles === "followup" && !args.hasStreamedThreadReply) {
    attachFiles = "inline";
  }

  return {
    shouldPostThreadReply: deliveryPlan.postThreadText,
    attachFiles
  };
}
