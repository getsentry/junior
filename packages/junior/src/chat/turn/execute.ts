import type { ReplyFileDelivery } from "@/chat/delivery/plan";
import type { AssistantReply } from "@/chat/respond";

const REACTION_ONLY_ACK_RE =
  /^(?::[a-z0-9_+-]+:|[\p{Extended_Pictographic}\uFE0F\u200D]+)$/u;
const REDUNDANT_REACTION_ACK_TEXT = new Set(["done", "got it", "ok", "okay"]);

function isRedundantReactionAckText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (REACTION_ONLY_ACK_RE.test(trimmed)) {
    return true;
  }

  const normalized = trimmed.toLowerCase().replace(/[!.]+$/g, "");
  return REDUNDANT_REACTION_ACK_TEXT.has(normalized);
}

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

  let attachFiles = deliveryPlan.attachFiles;
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
