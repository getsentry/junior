import { z } from "zod";
import { escapeXml } from "@/chat/xml";

export enum SubscribedReplyReason {
  ThreadOptOut = "thread_opt_out",
  ExplicitMention = "explicit_mention",
  DirectedToOtherParty = "directed_to_other_party",
  EmptyMessage = "empty_message",
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

interface TranscriptMessage {
  author: string;
  role: "assistant" | "system" | "user";
  text: string;
}

interface RouterSignals {
  assistantWasLastSpeaker: boolean;
  currentMessageHasDirectedFollowUpCue: boolean;
  currentMessageHasAttachments: boolean;
  currentMessageIsTerseClarification: boolean;
  humanMessagesSinceLastAssistant?: number;
  latestPriorAssistantMessage: string;
  latestPriorMessageRole: string;
  recentMessages: TranscriptMessage[];
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

const ROUTER_CONFIDENCE_THRESHOLD = 0.8;
const LEADING_SLACK_MENTION_RE = /^\s*<@([A-Z0-9]+)(?:\|([^>]+))?>[\s,:-]*/i;
const LEADING_NAMED_MENTION_RE = /^\s*@([a-z0-9._-]+)\b[\s,:-]*/i;
const TRANSCRIPT_MESSAGE_LINE_RE =
  /^\[(assistant|system|user)\]\s+([^:]+):\s+([\s\S]+)$/i;
const THREAD_OPTOUT_PATTERNS = [
  /\bstop (?:watching|replying|participating)\b/i,
  /\bstay out\b/i,
  /\bdon['’]t (?:reply|participate|watch)\b/i,
  /\bunsubscribe\b/i,
  /\bleave (?:this )?thread\b/i,
];
const ACKNOWLEDGMENT_ONLY_RE =
  /^(?:thanks(?: you)?|thank you|thx|ty|got it|sounds good|sgtm|lgtm|ok(?:ay)?|cool|nice|perfect|awesome|great|makes sense|understood|roger|yep|yup|kk|on it|will do)(?:[.!]+)?$/i;
const DIRECTED_FOLLOW_UP_CUE_RE =
  /\b(?:you said|you just said|your last response|your last answer|what did you just say|what do you mean|what did you mean|explain(?: that| this| it| more)?|clarify(?: that| this| it)?|expand(?: on)?(?: that| this| it)?|elaborate(?: on)?(?: that| this| it)?|say more)\b/i;
const TERSE_CLARIFICATION_RE =
  /^(?:which one|which ones|why|how so|what do you mean|what did you mean|say more|explain that|clarify that|expand on that|elaborate on that)\??$/i;
const GENERIC_IMMEDIATE_SIDE_CONVERSATION_RE =
  /^(?:is that (?:the )?right (?:approach|call|move)|(?:can|could|would) you check on this)\??$/i;
const RECENT_THREAD_WINDOW = 6;

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

function isAcknowledgmentOnly(text: string): boolean {
  return ACKNOWLEDGMENT_ONLY_RE.test(text.trim());
}

function hasDirectedFollowUpCue(text: string): boolean {
  return DIRECTED_FOLLOW_UP_CUE_RE.test(text.trim());
}

function isTerseClarification(text: string): boolean {
  return TERSE_CLARIFICATION_RE.test(text.trim());
}

function isGenericImmediateSideConversation(text: string): boolean {
  const trimmed = text.trim();
  if (GENERIC_IMMEDIATE_SIDE_CONVERSATION_RE.test(trimmed)) {
    return true;
  }

  if (!trimmed.toLowerCase().startsWith("what about")) {
    return false;
  }

  const wordCount = trimmed
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
  return wordCount > 3;
}

function parseTranscriptMessages(
  conversationContext: string | undefined,
): TranscriptMessage[] {
  if (!conversationContext) {
    return [];
  }

  const messages: TranscriptMessage[] = [];
  const lines = conversationContext
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const match = line.match(TRANSCRIPT_MESSAGE_LINE_RE);
    if (!match) {
      continue;
    }

    messages.push({
      role: match[1].toLowerCase() as TranscriptMessage["role"],
      author: match[2]?.trim() || "unknown",
      text: match[3]?.trim() || "",
    });
  }

  return messages;
}

function buildRouterSignals(input: SubscribedDecisionInput): RouterSignals {
  const transcriptMessages = parseTranscriptMessages(input.conversationContext);
  const recentMessages = transcriptMessages
    .filter((message) => message.role !== "system")
    .slice(-RECENT_THREAD_WINDOW);

  const latestPriorMessage = [...transcriptMessages]
    .reverse()
    .find((message) => message.role !== "system");
  const latestPriorAssistantMessage = [...transcriptMessages]
    .reverse()
    .find((message) => message.role === "assistant");

  let humanMessagesSinceLastAssistant: number | undefined;
  let humanMessageCount = 0;
  for (let index = transcriptMessages.length - 1; index >= 0; index -= 1) {
    const message = transcriptMessages[index];
    if (!message || message.role === "system") {
      continue;
    }
    if (message.role === "assistant") {
      humanMessagesSinceLastAssistant = humanMessageCount;
      break;
    }
    humanMessageCount += 1;
  }

  return {
    assistantWasLastSpeaker: latestPriorMessage?.role === "assistant",
    currentMessageHasDirectedFollowUpCue: hasDirectedFollowUpCue(input.text),
    currentMessageHasAttachments: Boolean(input.hasAttachments),
    currentMessageIsTerseClarification: isTerseClarification(input.text),
    humanMessagesSinceLastAssistant,
    latestPriorAssistantMessage: latestPriorAssistantMessage?.text || "[none]",
    latestPriorMessageRole: latestPriorMessage?.role || "[none]",
    recentMessages,
  };
}

function buildRouterPrompt(rawText: string, signals: RouterSignals): string {
  const recentThread =
    signals.recentMessages.length > 0
      ? signals.recentMessages
          .map((message) =>
            escapeXml(`[${message.role}] ${message.author}: ${message.text}`),
          )
          .join("\n")
      : "[none]";

  return [
    `<latest-message>${escapeXml(rawText.trim() || "[attachment-only message]")}</latest-message>`,
    "<routing-signals>",
    `assistant_was_last_speaker=${signals.assistantWasLastSpeaker ? "true" : "false"}`,
    `human_messages_since_last_assistant=${
      signals.humanMessagesSinceLastAssistant ?? "none"
    }`,
    `latest_prior_message_role=${escapeXml(signals.latestPriorMessageRole)}`,
    `current_message_has_directed_follow_up_cue=${
      signals.currentMessageHasDirectedFollowUpCue ? "true" : "false"
    }`,
    `current_message_is_terse_clarification=${
      signals.currentMessageIsTerseClarification ? "true" : "false"
    }`,
    `current_message_has_attachments=${
      signals.currentMessageHasAttachments ? "true" : "false"
    }`,
    "</routing-signals>",
    `<latest-prior-assistant-message>${escapeXml(
      signals.latestPriorAssistantMessage,
    )}</latest-prior-assistant-message>`,
    "<recent-thread>",
    recentThread,
    "</recent-thread>",
  ].join("\n");
}

function getReplyConfidenceThreshold(signals: RouterSignals): number {
  let threshold = ROUTER_CONFIDENCE_THRESHOLD;

  if (
    signals.assistantWasLastSpeaker &&
    signals.humanMessagesSinceLastAssistant === 0
  ) {
    if (
      signals.currentMessageHasDirectedFollowUpCue ||
      signals.currentMessageIsTerseClarification
    ) {
      threshold = 0.65;
    } else {
      threshold = 0.9;
    }
  } else if (
    signals.assistantWasLastSpeaker &&
    signals.humanMessagesSinceLastAssistant === 1
  ) {
    threshold = signals.currentMessageHasDirectedFollowUpCue ? 0.8 : 0.9;
  } else if (signals.humanMessagesSinceLastAssistant === undefined) {
    threshold = 0.85;
  } else if (signals.humanMessagesSinceLastAssistant >= 2) {
    threshold = 0.9;
  }

  return Math.max(0.6, Math.min(0.9, threshold));
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

function buildRouterSystemPrompt(botUserName: string): string {
  return [
    "You are a message router for a Slack assistant named Junior in a subscribed Slack thread.",
    "Decide whether Junior should reply to the latest message.",
    "Subscribed threads are passive by default.",
    "Reply true only when the latest message is aimed at Junior.",
    "Use who currently has the conversation floor, not just topic overlap.",
    "If Junior was the last speaker, only a clear turn back to Junior should count as an implicit follow-up.",
    "Terse clarifications like 'which one?' or 'why?' right after Junior answers can be should_reply=true.",
    "Direct self-reference to Junior's prior answer like 'what did you just say?' or 'explain that more' can be should_reply=true.",
    "If one or more humans spoke after Junior, require a clear turn back to Junior. Shared domain vocabulary alone is not enough.",
    "Questions like 'what about auth?' or 'can you check on this?' are usually human-to-human unless the thread clearly turns back to Junior.",
    "A vague question like 'is that the right approach?' is still should_reply=false unless it clearly turns back to Junior.",
    "Acknowledgments, reactions, status chatter, and team coordination should be should_reply=false.",
    "If the latest message clearly tells Junior to stop watching, replying, or participating, set should_unsubscribe=true and should_reply=false.",
    "When uncertain, prefer should_reply=false with low confidence.",
    "",
    "Return JSON with should_reply, should_unsubscribe, confidence, and a short reason.",
    "Do not return any extra keys.",
    "",
    `<assistant-name>${escapeXml(botUserName)}</assistant-name>`,
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
  const signals = buildRouterSignals(args.input);
  if (!text && !args.input.hasAttachments) {
    return { shouldReply: false, reason: SubscribedReplyReason.EmptyMessage };
  }
  if (!args.input.isExplicitMention && isAcknowledgmentOnly(text)) {
    return {
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "acknowledgment",
    };
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

  if (
    signals.assistantWasLastSpeaker &&
    signals.humanMessagesSinceLastAssistant === 0 &&
    !signals.currentMessageHasDirectedFollowUpCue &&
    !signals.currentMessageIsTerseClarification &&
    isGenericImmediateSideConversation(text)
  ) {
    return {
      shouldReply: false,
      reason: SubscribedReplyReason.SideConversation,
      reasonDetail: "generic immediate side conversation",
    };
  }

  try {
    const result = await args.completeObject({
      modelId: args.modelId,
      schema: replyDecisionSchema,
      maxTokens: 120,
      temperature: 0,
      system: buildRouterSystemPrompt(args.botUserName),
      prompt: buildRouterPrompt(rawText, signals),
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
    const replyConfidenceThreshold = getReplyConfidenceThreshold(signals);
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

    if (parsed.confidence < replyConfidenceThreshold) {
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
