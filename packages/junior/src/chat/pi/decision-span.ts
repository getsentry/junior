// The attributes of a `gen_ai.decide` span. A decision model gets shared
// state and typed questions and gives one answer per question, so the span
// records them as the input and output messages of a chat span. Questions can
// quote Conversation content, so they are content too. A private Conversation
// records only metadata.
import type {
  Experimental_DecisionQuestion,
  Experimental_DecisionResult,
  Experimental_DecisionState,
  Experimental_DecisionStatePart,
} from "ai";
import {
  toGenAiMessagesTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import { serializeGenAiAttribute } from "@/chat/logging";

type DecisionAnswers = Experimental_DecisionResult<
  Record<string, Experimental_DecisionQuestion>
>["answers"];

function canonicalStateParts(
  state: Experimental_DecisionState,
): Record<string, unknown>[] {
  if (typeof state === "string") {
    return [{ type: "text", content: state }];
  }
  if (!Array.isArray(state)) {
    return [{ type: "text", content: JSON.stringify(state) }];
  }
  // `Array.isArray` narrows a readonly array to `any[]`, so name the part type.
  return state.map((part: Experimental_DecisionStatePart) => {
    if (part.type === "text") return { type: "text", content: part.text };
    if (part.type === "json") {
      return { type: "text", content: JSON.stringify(part.value) };
    }
    // File bytes never go in a span.
    return { type: "blob", mime_type: part.mediaType };
  });
}

/** The attributes that a decision request has before it is sent. */
export function decisionStartAttributes(params: {
  privacy: ConversationPrivacy;
  questions: Record<string, Experimental_DecisionQuestion>;
  state: Experimental_DecisionState;
}): Record<string, unknown> {
  const content = params.privacy === "public";
  // Question ids come from code, so they are safe in every Conversation.
  return {
    "app.conversation.privacy": params.privacy,
    "app.decision.question.ids": Object.keys(params.questions),
    ...toGenAiMessagesTraceAttributes("gen_ai.input", [
      { role: "user", content: params.state },
    ]),
    ...(content
      ? {
          "gen_ai.system_instructions": serializeGenAiAttribute([
            { type: "text", content: JSON.stringify(params.questions) },
          ]),
          "gen_ai.input.messages": serializeGenAiAttribute([
            { role: "user", parts: canonicalStateParts(params.state) },
          ]),
        }
      : undefined),
  };
}

/** The attributes that the answers of a decision give. */
export function decisionEndAttributes(params: {
  answers: DecisionAnswers;
  privacy: ConversationPrivacy;
  response: { id?: string; modelId: string };
}): Record<string, unknown> {
  // Answers hold only choice names from code, probabilities, and scores, so
  // they are safe in every Conversation.
  const answers = JSON.stringify(params.answers);
  return {
    "app.decision.answers": answers,
    ...(params.privacy === "public"
      ? {
          "gen_ai.output.messages": serializeGenAiAttribute([
            {
              role: "assistant",
              parts: [{ type: "text", content: answers }],
            },
          ]),
        }
      : undefined),
    "gen_ai.response.model": params.response.modelId,
    "gen_ai.response.id": params.response.id,
  };
}
