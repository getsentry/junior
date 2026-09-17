import { z } from "zod";
import type {
  RouterEvidence,
  SubscribedReplyClassification,
} from "@/chat/services/subscribed-decision";

const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

const jevResponseSchema = z
  .object({
    answers: z
      .object({
        should_reply: z
          .object({ type: z.literal("noul"), noul: z.number().min(0).max(1) })
          .strict(),
        should_unsubscribe: z
          .object({ type: z.literal("noul"), noul: z.number().min(0).max(1) })
          .strict(),
      })
      .strict(),
  })
  .passthrough();

const REPLY_THRESHOLD = 0.8;
const UNSUBSCRIBE_THRESHOLD = 0.9;
const REQUEST_TIMEOUT_MS = 2_000;

export interface JevSubscribedReplyClassifierOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

/** Create a JEV classifier for passive replies in subscribed Slack threads. */
export function createJevSubscribedReplyClassifier(
  options: JevSubscribedReplyClassifierOptions,
): (args: {
  botUserName: string;
  evidence: RouterEvidence;
  latestMessage: string;
}) => Promise<SubscribedReplyClassification> {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return async ({ botUserName, evidence, latestMessage }) => {
    const response = await fetchImpl(TYPESAFE_SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: {
          assistant_name: botUserName,
          transcript: evidence.entries,
          signals: {
            assistant_was_last_speaker: evidence.assistantWasLastSpeaker,
            current_message_has_attachments:
              evidence.currentMessageHasAttachments,
            current_message_has_directed_follow_up_cue:
              evidence.currentMessageHasDirectedFollowUpCue,
            current_message_is_terse_clarification:
              evidence.currentMessageIsTerseClarification,
            human_messages_since_last_assistant:
              evidence.humanMessagesSinceLastAssistant ?? null,
            latest_prior_message_role: evidence.latestPriorMessageRole,
          },
          latest_prior_assistant_message: evidence.latestPriorAssistantMessage,
          latest_message: latestMessage,
        },
        questions: {
          should_reply: {
            type: "noul",
            instructions:
              "Should the assistant reply to the latest message in this Slack thread?",
            criteria: {
              true: "The latest message asks the assistant to act, answer, clarify, or continue its work.",
              false:
                "The message is side conversation, an acknowledgment, or directed to another person.",
            },
          },
          should_unsubscribe: {
            type: "noul",
            instructions:
              "Does the latest message clearly ask the assistant to stop participating in this thread?",
            criteria: {
              true: "The user clearly asks the assistant to leave or stop replying in this thread.",
              false: "The user does not clearly opt out of assistant replies.",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `TypeSafe System One request failed (${response.status})`,
      );
    }

    const result = jevResponseSchema.parse(await response.json());
    const replyProbability = result.answers.should_reply.noul;
    const unsubscribeProbability = result.answers.should_unsubscribe.noul;

    const shouldUnsubscribe = unsubscribeProbability >= UNSUBSCRIBE_THRESHOLD;
    return {
      shouldReply: replyProbability >= REPLY_THRESHOLD,
      shouldUnsubscribe,
      confidence: shouldUnsubscribe
        ? Math.max(unsubscribeProbability, 1 - unsubscribeProbability)
        : Math.max(replyProbability, 1 - replyProbability),
      reason: `jev reply=${replyProbability.toFixed(2)} unsubscribe=${unsubscribeProbability.toFixed(2)}`,
    };
  };
}
