import { z } from "zod";
import { escapeXml } from "@/chat/xml";
import { isProviderRetryError } from "@/chat/services/provider-error";

export enum SubscribedReplyReason {
  ThreadOptOut = "thread_opt_out",
  ExplicitMention = "explicit_mention",
  DirectedFollowUp = "directed_follow_up",
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
    actorId?: string;
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

const replyDecisionSchema = z
  .object({
    should_reply: z
      .boolean()
      .describe("Whether Junior should respond to this thread message."),
    should_unsubscribe: z
      .boolean()
      .describe(
        "Whether Junior should unsubscribe from this thread because the user clearly asked it to stop participating.",
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Classifier confidence from 0 to 1."),
    reason: z
      .string()
      .describe("Short reason for the decision; use an empty string if none."),
  })
  .strict();

const ROUTER_CONFIDENCE_THRESHOLD = 0.7;
const ROUTER_CLASSIFIER_MAX_TOKENS = 400;
const LEADING_SLACK_MENTION_RE = /^\s*<@([A-Z0-9]+)(?:\|([^>]+))?>[\s,:-]*/i;
const LEADING_NAMED_MENTION_RE = /^\s*@([a-z0-9._-]+)\b[\s,:-]*/i;
const TRANSCRIPT_MESSAGE_LINE_RE =
  /^\[(assistant|system|user)\]\s+([^:]+):\s+([\s\S]+)$/i;
const FORCED_THREAD_OPTOUT_RE = /^!stop(?:\s|$)/i;
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
const RECENT_THREAD_WINDOW = 40;
const MAX_ROUTER_CONTEXT_CHARS = 40_000;

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

function isForcedThreadOptOutCommand(rawText: string, text: string): boolean {
  return (
    FORCED_THREAD_OPTOUT_RE.test(rawText.trim()) ||
    FORCED_THREAD_OPTOUT_RE.test(text.trim())
  );
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
  const recentMessages: TranscriptMessage[] = [];
  let recentMessageChars = 0;
  const visibleMessages = transcriptMessages.filter(
    (entry) => entry.role === "assistant" || entry.role === "user",
  );
  for (const message of visibleMessages
    .slice(-RECENT_THREAD_WINDOW)
    .reverse()) {
    const entryChars = message.author.length + message.text.length;
    if (
      recentMessages.length > 0 &&
      recentMessageChars + entryChars > MAX_ROUTER_CONTEXT_CHARS
    ) {
      break;
    }
    recentMessages.unshift(message);
    recentMessageChars += entryChars;
  }
  const firstUserMessage = visibleMessages.find(
    (message) => message.role === "user",
  );
  if (
    firstUserMessage &&
    !recentMessages.includes(firstUserMessage) &&
    recentMessageChars +
      firstUserMessage.author.length +
      firstUserMessage.text.length <=
      MAX_ROUTER_CONTEXT_CHARS
  ) {
    recentMessages.unshift(firstUserMessage);
  }

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
  const assistantName = escapeXml(botUserName);
  return [
    `You are a message router for a Slack assistant named ${assistantName} in a subscribed Slack thread.`,
    `Decide whether ${assistantName} should reply to the latest message.`,
    "Subscribed threads are passive, but the assistant should participate when the conversation naturally continues work it was doing.",
    `Reply true when the latest message is explicitly aimed at ${assistantName} or is a natural follow-up to ${assistantName}'s prior question, answer, analysis, or action.`,
    "Judge the whole user/assistant exchange and who currently has the conversation floor; do not require an explicit name or pronoun when continuity makes the addressee clear.",
    `If ${assistantName} was the last speaker, questions, corrections, added constraints, requests to act, and topic-specific continuations can be implicit follow-ups even without words like 'you' or '${assistantName}'.`,
    `Terse continuations like 'which one?', 'why?', 'what about auth?', or 'can you check on this?' can be should_reply=true when they naturally continue ${assistantName}'s immediately preceding contribution.`,
    `If humans continued a side conversation after ${assistantName}, reply only when the latest message turns the floor back to ${assistantName} or clearly asks for work ${assistantName} was already handling.`,
    "Shared topic vocabulary alone is not enough when the latest message is plainly human-to-human.",
    "Acknowledgments, reactions, status chatter, and team coordination that do not ask the assistant to continue should be should_reply=false.",
    `If the latest message clearly tells ${assistantName} to stop watching, replying, or participating, set should_unsubscribe=true and should_reply=false.`,
    "Use low confidence for genuinely ambiguous floor ownership; do not lower confidence merely because the assistant was addressed implicitly.",
    "",
    "Return JSON with should_reply, should_unsubscribe, confidence, and a reason under 160 characters.",
    "Do not return any extra keys.",
    "",
    `<assistant-name>${assistantName}</assistant-name>`,
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
  if (isForcedThreadOptOutCommand(rawText, text)) {
    return {
      shouldReply: false,
      shouldUnsubscribe: true,
      reason: SubscribedReplyReason.ThreadOptOut,
      reasonDetail: "forced !stop command",
    };
  }
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
  if (
    !args.input.isExplicitMention &&
    !args.input.hasAttachments &&
    isAcknowledgmentOnly(text)
  ) {
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
    !signals.currentMessageHasAttachments &&
    (signals.currentMessageHasDirectedFollowUpCue ||
      signals.currentMessageIsTerseClarification)
  ) {
    return {
      shouldReply: true,
      reason: SubscribedReplyReason.DirectedFollowUp,
      reasonDetail: signals.currentMessageIsTerseClarification
        ? "immediate terse clarification"
        : "immediate directed follow-up cue",
    };
  }

  try {
    const result = await args.completeObject({
      modelId: args.modelId,
      schema: replyDecisionSchema,
      maxTokens: ROUTER_CLASSIFIER_MAX_TOKENS,
      temperature: 0,
      system: buildRouterSystemPrompt(args.botUserName),
      prompt: buildRouterPrompt(rawText, signals),
      metadata: {
        modelId: args.modelId,
        threadId: args.input.context.threadId ?? "",
        channelId: args.input.context.channelId ?? "",
        actorId: args.input.context.actorId ?? "",
        runId: args.input.context.runId ?? "",
      },
    });

    const parsed = replyDecisionSchema.parse(result.object);
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
    if (isProviderRetryError(error)) {
      throw error;
    }
    args.logClassifierFailure(error, args.input);
    return {
      shouldReply: false,
      reason: SubscribedReplyReason.ClassifierError,
    };
  }
}
