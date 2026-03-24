import { z } from "zod";
import { escapeXml } from "@/chat/xml";

export enum SubscribedReplyReason {
  ThreadOptOut = "thread_opt_out",
  ExplicitMention = "explicit_mention",
  DirectedToOtherParty = "directed_to_other_party",
  EmptyMessage = "empty_message",
  AttachmentOnly = "attachment_only",
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
  shouldUnsubscribe?: boolean;
  reason: SubscribedReplyReason;
  reasonDetail?: string;
}

interface ClassifierResult {
  should_reply: boolean;
  should_unsubscribe?: boolean;
  confidence: number;
  reason?: string;
}

const replyDecisionSchema = z.object({
  should_reply: z
    .boolean()
    .describe("Whether Junior should respond to this thread message."),
  should_unsubscribe: z
    .boolean()
    .optional()
    .describe(
      "Whether Junior should unsubscribe from this thread because the user clearly asked it to stop participating.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Classifier confidence from 0 to 1."),
  reason: z.string().optional().describe("Short reason for the decision."),
});

const ROUTER_CONFIDENCE_THRESHOLD = 0.9;
const LEADING_SLACK_MENTION_RE = /^\s*<@([A-Z0-9]+)(?:\|([^>]+))?>[\s,:-]*/i;
const LEADING_NAMED_MENTION_RE = /^\s*@([a-z0-9._-]+)\b[\s,:-]*/i;
const THREAD_OPTOUT_PATTERNS = [
  /\bstop (?:watching|replying|participating)\b/i,
  /\bstay out\b/i,
  /\bdon['’]t (?:reply|participate|watch)\b/i,
  /\bunsubscribe\b/i,
  /\bleave (?:this )?thread\b/i,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function isThreadOptOutInstruction(rawText: string, text: string): boolean {
  return THREAD_OPTOUT_PATTERNS.some(
    (pattern) => pattern.test(rawText) || pattern.test(text),
  );
}
/** Fast heuristic check before the LLM classifier — skips messages directed at another party. */
export function getSubscribedReplyPreflightDecision(args: {
  botUserName: string;
  rawText: string;
  text: string;
  isExplicitMention?: boolean;
}): SubscribedDecisionResult | undefined {
  const text = args.text.trim();
  const rawText = args.rawText.trim();

  if (args.isExplicitMention) {
    return undefined;
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
  isExplicitMention: boolean | undefined,
): string {
  return [
    "You are a message router for a Slack assistant named Junior in a subscribed Slack thread.",
    "Decide whether Junior should reply to the latest message.",
    "Subscribed threads are passive by default.",
    "Default to should_reply=false unless the user is clearly asking Junior for help or follow-up.",
    "A direct @mention is a strong signal to reply unless the message is clearly telling Junior to stop participating.",
    "",
    "Reply should be true only when the user is clearly asking Junior a question, requesting help,",
    "or when a direct follow-up is contextually aimed at Junior's previous response in the thread context.",
    "",
    "Reply should be false for side conversations between humans, acknowledgements,",
    "status chatter, or messages not seeking assistant input.",
    "Junior must not participate in casual banter or keep chiming in just because it replied earlier.",
    "",
    "Examples of messages Junior should NOT reply to (should_reply=false):",
    "- Questions between humans: 'Is that the right approach?', 'Can you check on this?', 'Did you deploy that?'",
    "- Acknowledgments: 'thanks', '+1', 'lgtm', 'ok cool', 'sounds good', 'nice'",
    "- Status updates: 'I just pushed a fix', 'Deploying now', 'Build is green'",
    "- General thread discussion: 'What about the billing issue?', 'I think we should revert'",
    "- Reactions to work: 'That looks wrong', 'Nice catch', 'Hmm interesting'",
    "",
    "Examples of messages Junior SHOULD reply to (should_reply=true):",
    "- Direct follow-ups to Junior's response: 'Can you explain that last point in more detail?'",
    "- Explicit requests for Junior's help: 'Junior, what's causing this error?'",
    "",
    "When in doubt, should_reply=false. Most messages in a thread are human-to-human conversation.",
    "",
    "If the user is clearly telling Junior to stop watching, replying, or participating in the thread,",
    "set should_unsubscribe=true and should_reply=false.",
    "Use should_unsubscribe only for clear thread opt-out instructions, not for ordinary side conversation.",
    "If uncertain, set should_reply=false and use low confidence.",
    "",
    "Return JSON with should_reply, should_unsubscribe, confidence, and a short reason.",
    "Do not return any extra keys.",
    "",
    `<assistant-name>${escapeXml(botUserName)}</assistant-name>`,
    `<explicit-mention>${isExplicitMention ? "true" : "false"}</explicit-mention>`,
    `<thread-context>${escapeXml(conversationContext?.trim() || "[none]")}</thread-context>`,
  ].join("\n");
}

/** Decide whether to reply to a message in a subscribed thread using an LLM classifier. */
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

  if (args.input.isExplicitMention) {
    if (isThreadOptOutInstruction(rawText, text)) {
      return {
        shouldReply: false,
        shouldUnsubscribe: true,
        reason: SubscribedReplyReason.ThreadOptOut,
        reasonDetail: "explicit stop instruction",
      };
    }
    return {
      shouldReply: true,
      reason: SubscribedReplyReason.ExplicitMention,
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
        args.input.isExplicitMention,
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
    if (parsed.should_unsubscribe) {
      if (parsed.confidence < ROUTER_CONFIDENCE_THRESHOLD) {
        return {
          shouldReply: false,
          reason: SubscribedReplyReason.LowConfidence,
          reasonDetail: `${parsed.confidence.toFixed(2)}: ${reason}`,
        };
      }

      return {
        shouldReply: false,
        shouldUnsubscribe: true,
        reason: SubscribedReplyReason.ThreadOptOut,
        reasonDetail: reason,
      };
    }

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
