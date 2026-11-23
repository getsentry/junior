// What the host gives core to build each step of a Turn: the prompt layout,
// which turns each unread input into a user message with instruction
// authority for its Actor, and the model settings of the claimed Turn. The
// host gives the database and the bot settings, so this file reads no
// globals.
import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { BotConfig } from "@/chat/config";
import { resolveConversationPrivacy } from "@/chat/conversation-privacy";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import type { EngineContext } from "@/core/engine-context";
import type { ModelSettings } from "@/core/model/client";
import {
  definePromptLayout,
  inputs,
  type InputPrompt,
  type PromptLayout,
} from "@/core/prompt/layout";
import type { UnreadInput } from "@/core/turn/inbox";
import type { ClaimedTurn } from "@/core/turn/state";

const turnInputPayloadSchema = z
  .object({ text: z.string().min(1), actor: actorSchema })
  .strict();

/** The payload of an inbox row that the host's layout reads. */
export type TurnInputPayload = z.output<typeof turnInputPayloadSchema>;

function formatInput(input: UnreadInput): InputPrompt {
  const payload = turnInputPayloadSchema.parse(input.payload);
  return {
    message: {
      role: "user",
      content: [{ type: "text", text: payload.text }],
      timestamp: input.sentAt.getTime(),
    },
    provenance: instructionProvenanceFor(payload.actor),
  };
}

/**
 * Builds the host's prompt layout once: the deployment's system prompt, then
 * the unread inputs after the history.
 */
export async function buildTurnPromptLayout(): Promise<PromptLayout> {
  return definePromptLayout({
    // The engine has no Delivery yet, so the reply stays in history. A Turn
    // without Delivery gets the local rules.
    systemPrompt: [
      {
        name: "deployment",
        text: await buildDeploymentSystemPrompt("local", "conversation"),
      },
    ],
    messages: [inputs({ format: formatInput })],
  });
}

/**
 * Gives the model settings of a claimed Turn: `bot`'s model with the
 * Conversation's privacy. It reads `bot` at each step, so a later change
 * applies.
 */
export function turnModelSettings({
  executor,
  bot,
}: Pick<EngineContext, "executor"> & { bot: BotConfig }) {
  return async (turn: ClaimedTurn): Promise<ModelSettings> => {
    const { visibility } = await resolveRootVisibility(
      executor,
      turn.conversationId,
    );
    return {
      id: bot.modelId,
      reasoning: bot.reasoningLevel,
      privacy: resolveConversationPrivacy({
        visibility: visibility ?? undefined,
      }),
    };
  };
}
