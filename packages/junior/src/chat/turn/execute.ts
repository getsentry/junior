import {
  isRedundantReactionAckText,
  type ReplyFileDelivery,
} from "@/chat/delivery/plan";
import type { AssistantReply } from "@/chat/respond";

export function resolveReplyDelivery(args: {
  reply: AssistantReply;
  hasStreamedThreadReply: boolean;
}): {
  shouldPostThreadReply: boolean;
  attachFiles: ReplyFileDelivery;
} {
  const replyHasFiles = Boolean(
    args.reply.files && args.reply.files.length > 0,
  );
  const deliveryPlan = args.reply.deliveryPlan ?? {
    mode: args.reply.deliveryMode ?? "thread",
    ack: args.reply.ackStrategy ?? "none",
    postThreadText: (args.reply.deliveryMode ?? "thread") !== "channel_only",
    attachFiles: replyHasFiles
      ? args.hasStreamedThreadReply
        ? "followup"
        : "inline"
      : "none",
  };

  let attachFiles = replyHasFiles ? deliveryPlan.attachFiles : "none";
  if (attachFiles === "followup" && !args.hasStreamedThreadReply) {
    attachFiles = "inline";
  }
  const suppressRedundantReactionReply =
    deliveryPlan.ack === "reaction" &&
    !replyHasFiles &&
    isRedundantReactionAckText(args.reply.text);

  return {
    shouldPostThreadReply:
      deliveryPlan.postThreadText && !suppressRedundantReactionReply,
    attachFiles,
  };
}
