export type ReplyDeliveryMode = "thread" | "channel_only";
export type ReplyAckStrategy = "none" | "reaction";
export type ReplyFileDelivery = "none" | "inline" | "followup";

export interface ReplyDeliveryPlan {
  mode: ReplyDeliveryMode;
  ack: ReplyAckStrategy;
  postThreadText: boolean;
  attachFiles: ReplyFileDelivery;
}

const REACTION_ONLY_ACK_RE =
  /^(?::[a-z0-9_+-]+:|[\p{Extended_Pictographic}\uFE0F\u200D]+)$/u;
const REDUNDANT_REACTION_ACK_TEXT = ["done", "got it", "ok", "okay"] as const;
const REACTION_ALIAS_PREFIX_RE = /^:[a-z0-9_+-]*$/i;

function normalizeReactionAckText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[!.]+$/g, "");
}

export function isRedundantReactionAckText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (REACTION_ONLY_ACK_RE.test(trimmed)) {
    return true;
  }

  const normalized = normalizeReactionAckText(text);
  return REDUNDANT_REACTION_ACK_TEXT.includes(
    normalized as (typeof REDUNDANT_REACTION_ACK_TEXT)[number],
  );
}

export function isPotentialRedundantReactionAckText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  if (
    REACTION_ONLY_ACK_RE.test(trimmed) ||
    REACTION_ALIAS_PREFIX_RE.test(trimmed)
  ) {
    return true;
  }

  const normalized = normalizeReactionAckText(text);
  return REDUNDANT_REACTION_ACK_TEXT.some((candidate) =>
    candidate.startsWith(normalized),
  );
}

export function buildReplyDeliveryPlan(args: {
  explicitChannelPostIntent: boolean;
  channelPostPerformed: boolean;
  reactionPerformed: boolean;
  hasFiles: boolean;
  streamingThreadReply: boolean;
}): ReplyDeliveryPlan {
  const mode: ReplyDeliveryMode =
    args.explicitChannelPostIntent && args.channelPostPerformed
      ? "channel_only"
      : "thread";

  let attachFiles: ReplyFileDelivery = "none";
  if (args.hasFiles && mode === "thread") {
    attachFiles = args.streamingThreadReply ? "followup" : "inline";
  }

  return {
    mode,
    ack: args.reactionPerformed ? "reaction" : "none",
    postThreadText: mode === "thread",
    attachFiles,
  };
}
