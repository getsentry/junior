// The host's `prepare` for the core Turn engine. It gives the system prompt
// and the model settings of the claimed Turn, and turns each unread input
// into a user message with instruction authority for its Actor. It gives no
// tools yet.
import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { getChatConfig } from "@/chat/config";
import { resolveConversationPrivacy } from "@/chat/conversation-privacy";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { getSqlExecutor } from "@/chat/db";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import type { PreparedStep } from "@/core/turn/advance";
import type { InputMessage, UnreadInput } from "@/core/turn/inbox";
import type { ClaimedTurn } from "@/core/turn/state";

const turnInputPayloadSchema = z
  .object({ text: z.string().min(1), actor: actorSchema })
  .strict();

/** The payload of an inbox row that this `prepare` reads. */
export type TurnInputPayload = z.output<typeof turnInputPayloadSchema>;

function inputMessage(input: UnreadInput): InputMessage {
  const payload = turnInputPayloadSchema.parse(input.payload);
  return {
    inputId: input.inputId,
    message: {
      role: "user",
      content: [{ type: "text", text: payload.text }],
      timestamp: input.sentAt.getTime(),
    },
    provenance: instructionProvenanceFor(payload.actor),
  };
}

/**
 * Prepares one step of a claimed Turn: the system prompt, the model settings
 * with the Conversation's privacy, and the inputs as user messages.
 */
export async function prepareTurnStep(
  turn: ClaimedTurn,
  inputs: UnreadInput[],
): Promise<PreparedStep & { inputs: InputMessage[] }> {
  const { bot } = getChatConfig();
  const { visibility } = await resolveRootVisibility(
    getSqlExecutor(),
    turn.conversationId,
  );
  return {
    // The engine has no Delivery yet, so the reply stays in history. A Turn
    // without Delivery gets the local rules.
    systemPrompt: await buildDeploymentSystemPrompt("local", "conversation"),
    tools: [],
    model: {
      id: bot.modelId,
      reasoning: bot.reasoningLevel,
      privacy: resolveConversationPrivacy({
        visibility: visibility ?? undefined,
      }),
    },
    inputs: inputs.map(inputMessage),
  };
}
