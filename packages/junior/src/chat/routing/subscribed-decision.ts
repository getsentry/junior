import { z } from "zod";
import { escapeXml } from "@/chat/xml";

export enum SubscribedReplyReason {
  ExplicitMention = "explicit_mention",
  DirectedToOtherParty = "directed_to_other_party",
  EmptyMessage = "empty_message",
  AttachmentOnly = "attachment_only",
  Acknowledgment = "acknowledgment",
  FollowUpQuestion = "follow_up_question",
  Classifier = "llm_classifier",
  SideConversation = "side_conversation",
  LowConfidence = "low_confidence",
  ClassifierError = "classifier_error",
}

export interface SubscribedDecisionInput {
  rawText: string;
  text: string;
  conversationContext?: string;
  hasAttachments?: boolean;
  isExplicitMention?: boolean;
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    runId?: string;
  };
}

export interface SubscribedDecisionResult {
  shouldReply: boolean;
  reason: SubscribedReplyReason;
  reasonDetail?: string;
}

interface ClassifierResult {
  should_reply: boolean;
  confidence: number;
  reason?: string;
}

const replyDecisionSchema = z.object({
  should_reply: z
    .boolean()
    .describe("Whether Junior should respond to this thread message."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Classifier confidence from 0 to 1."),
  reason: z
    .string()
    .max(160)
    .optional()
    .describe("Short reason for the decision."),
});

const ROUTER_CONFIDENCE_THRESHOLD = 0.72;
const ACK_REGEXES: RegExp[] = [
  /^(thanks|thank you|thx|ty|tysm|much appreciated)[!. ]*$/i,
  /^(ok|okay|k|got it|sgtm|lgtm|sounds good|works for me|works|done|resolved|perfect|great|nice|cool)[!. ]*$/i,
  /^(\+1|\+\+|ack|roger|copy that)[!. ]*$/i,
  /^(:[a-z0-9_+-]+:|[\p{Extended_Pictographic}\uFE0F\u200D])+[!. ]*$/u,
];
const QUESTION_PREFIX_RE =
  /^(what|why|how|when|where|which|who|can|could|would|should|do|does|did|is|are|was|were|will)\b/i;
const FOLLOW_UP_REF_RE =
  /\b(you|your|that|this|it|above|previous|earlier|last|just\s+said)\b/i;
const LEADING_SLACK_MENTION_RE = /^\s*<@([A-Z0-9]+)(?:\|([^>]+))?>[\s,:-]*/i;
const LEADING_NAMED_MENTION_RE = /^\s*@([a-z0-9._-]+)\b[\s,:-]*/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeForOverlap(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

function getLastAssistantLine(
  conversationContext: string | undefined,
): string | undefined {
  if (!conversationContext) return undefined;

  const lines = conversationContext
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.startsWith("[assistant]")) {
      return line;
    }
  }

  return undefined;
}

function isLikelyAcknowledgment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("?")) return false;

  for (const regex of ACK_REGEXES) {
    if (regex.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function isLikelyAssistantDirectedFollowUp(
  text: string,
  conversationContext: string | undefined,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const isQuestion = trimmed.includes("?") || QUESTION_PREFIX_RE.test(trimmed);
  if (!isQuestion) {
    return false;
  }

  const lastAssistantLine = getLastAssistantLine(conversationContext);
  if (!lastAssistantLine) {
    return false;
  }

  if (FOLLOW_UP_REF_RE.test(trimmed)) {
    return true;
  }

  const questionTokens = tokenizeForOverlap(trimmed);
  const assistantTokens = new Set(tokenizeForOverlap(lastAssistantLine));
  for (const token of questionTokens) {
    if (assistantTokens.has(token)) {
      return true;
    }
  }

  return false;
}

function containsAssistantInvocation(
  text: string,
  botUserName: string,
): boolean {
  const escapedUserName = escapeRegExp(botUserName);
  const plainNameMentionRe = new RegExp(`(^|\\s)@${escapedUserName}\\b`, "i");
  const labeledEntityMentionRe = new RegExp(
    `<@[^>|]+\\|${escapedUserName}>`,
    "i",
  );

  return plainNameMentionRe.test(text) || labeledEntityMentionRe.test(text);
}

function detectLeadingOtherPartyAddress(
  rawText: string,
  text: string,
  botUserName: string,
): string | undefined {
  if (
    containsAssistantInvocation(rawText, botUserName) ||
    containsAssistantInvocation(text, botUserName)
  ) {
    return undefined;
  }

  const leadingSlackMention = rawText.match(LEADING_SLACK_MENTION_RE);
  if (leadingSlackMention) {
    const label = leadingSlackMention[2]?.trim();
    return label ? `slack_mention:${label}` : "slack_mention";
  }

  const leadingNamedMention = text.match(LEADING_NAMED_MENTION_RE);
  if (!leadingNamedMention) {
    return undefined;
  }

  const directedName = leadingNamedMention[1]?.trim();
  if (
    !directedName ||
    directedName.toLowerCase() === botUserName.toLowerCase()
  ) {
    return undefined;
  }

  return `named_mention:${directedName}`;
}

export function getSubscribedReplyPreflightDecision(args: {
  botUserName: string;
  rawText: string;
  text: string;
  isExplicitMention?: boolean;
}): SubscribedDecisionResult | undefined {
  const text = args.text.trim();
  const rawText = args.rawText.trim();

  if (args.isExplicitMention) {
    return { shouldReply: true, reason: SubscribedReplyReason.ExplicitMention };
  }

  const leadingOtherPartyAddress = detectLeadingOtherPartyAddress(
    rawText,
    text,
    args.botUserName,
  );
  if (!leadingOtherPartyAddress) {
    return undefined;
  }

  return {
    shouldReply: false,
    reason: SubscribedReplyReason.DirectedToOtherParty,
    reasonDetail: leadingOtherPartyAddress,
  };
}

function buildRouterSystemPrompt(
  botUserName: string,
  conversationContext: string | undefined,
): string {
  return [
    "You are a message router for a Slack assistant named Junior in a subscribed Slack thread.",
    "Decide whether Junior should reply to the latest message.",
    "Default to should_reply=false unless the user is clearly asking Junior for help or follow-up.",
    "",
    "Reply should be true only when the user is clearly asking Junior a question, requesting help,",
    "or when a direct follow-up is contextually aimed at Junior's previous response in the thread context.",
    "",
    "Reply should be false for side conversations between humans, acknowledgements (thanks, +1),",
    "status chatter, or messages not seeking assistant input.",
    "Junior must not participate in casual banter.",
    "If uncertain, set should_reply=false and use low confidence.",
    "",
    "Return JSON with should_reply, confidence, and a short reason. Do not return any extra keys.",
    "",
    `<assistant-name>${escapeXml(botUserName)}</assistant-name>`,
    `<thread-context>${escapeXml(conversationContext?.trim() || "[none]")}</thread-context>`,
  ].join("\n");
}

export async function decideSubscribedThreadReply(args: {
  botUserName: string;
  modelId: string;
  input: SubscribedDecisionInput;
  completeObject: (args: {
    modelId: string;
    schema: typeof replyDecisionSchema;
    maxTokens: number;
    temperature: number;
    system: string;
    prompt: string;
    metadata: Record<string, string>;
  }) => Promise<{ object: unknown }>;
  logClassifierFailure: (
    error: unknown,
    input: SubscribedDecisionInput,
  ) => void;
}): Promise<SubscribedDecisionResult> {
  const text = args.input.text.trim();
  const rawText = args.input.rawText.trim();
  const preflightDecision = getSubscribedReplyPreflightDecision({
    botUserName: args.botUserName,
    rawText,
    text,
    isExplicitMention: args.input.isExplicitMention,
  });
  if (preflightDecision) {
    return preflightDecision;
  }
  if (!text && !args.input.hasAttachments) {
    return { shouldReply: false, reason: SubscribedReplyReason.EmptyMessage };
  }
  if (!text && args.input.hasAttachments) {
    return { shouldReply: true, reason: SubscribedReplyReason.AttachmentOnly };
  }
  if (isLikelyAcknowledgment(text)) {
    return { shouldReply: false, reason: SubscribedReplyReason.Acknowledgment };
  }
  if (isLikelyAssistantDirectedFollowUp(text, args.input.conversationContext)) {
    return {
      shouldReply: true,
      reason: SubscribedReplyReason.FollowUpQuestion,
    };
  }

  try {
    const result = await args.completeObject({
      modelId: args.modelId,
      schema: replyDecisionSchema,
      maxTokens: 120,
      temperature: 0,
      system: buildRouterSystemPrompt(
        args.botUserName,
        args.input.conversationContext,
      ),
      prompt: rawText,
      metadata: {
        modelId: args.modelId,
        threadId: args.input.context.threadId ?? "",
        channelId: args.input.context.channelId ?? "",
        requesterId: args.input.context.requesterId ?? "",
        runId: args.input.context.runId ?? "",
      },
    });

    const parsed = replyDecisionSchema.parse(result.object) as ClassifierResult;
    const reason = parsed.reason?.trim() || "classifier";
    if (!parsed.should_reply) {
      return {
        shouldReply: false,
        reason: SubscribedReplyReason.SideConversation,
        reasonDetail: reason,
      };
    }

    if (parsed.confidence < ROUTER_CONFIDENCE_THRESHOLD) {
      return {
        shouldReply: false,
        reason: SubscribedReplyReason.LowConfidence,
        reasonDetail: `${parsed.confidence.toFixed(2)}: ${reason}`,
      };
    }

    return {
      shouldReply: true,
      reason: SubscribedReplyReason.Classifier,
      reasonDetail: reason,
    };
  } catch (error) {
    args.logClassifierFailure(error, args.input);
    return {
      shouldReply: false,
      reason: SubscribedReplyReason.ClassifierError,
    };
  }
}
