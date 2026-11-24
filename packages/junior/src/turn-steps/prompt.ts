// What the host gives core to build each step of a Turn: the prompt layout
// of the Turn's platform, which turns each unread input into a user message
// with instruction authority for its Actor, and the model settings of the
// claimed Turn. The host gives the database and the bot settings, so this
// file reads no globals.
import { actorSchema, type Platform } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import * as z from "zod";
import type { BotConfig } from "@/chat/config";
import { resolveConversationPrivacy } from "@/chat/conversation-privacy";
import { locationSchema } from "@/chat/conversations/location";
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
import { juniorConversations } from "@/db/schema";

const turnInputPayloadSchema = z
  .object({ text: z.string().min(1), actor: actorSchema })
  .strict();

/** The payload of an inbox row that the host's layout reads. */
export type TurnInputPayload = z.output<typeof turnInputPayloadSchema>;

function formatInput(input: UnreadInput): InputPrompt {
  const payload = turnInputPayloadSchema.parse(input.payload);
  return {
    message: { role: "user", content: [{ type: "text", text: payload.text }] },
    provenance: instructionProvenanceFor(payload.actor),
  };
}

/** The prompt layout of each platform that core Turns reply on. */
type TurnPromptLayouts = Readonly<Record<Platform, PromptLayout>>;

async function platformPromptLayout(platform: Platform): Promise<PromptLayout> {
  return definePromptLayout({
    systemPrompt: [
      {
        name: "deployment",
        text: await buildDeploymentSystemPrompt(platform, "conversation"),
      },
    ],
    messages: [inputs({ format: formatInput })],
  });
}

/**
 * Builds the host's prompt layouts once, one for each platform: the
 * platform's deployment system prompt, then the unread inputs after the
 * history. Every Turn on a platform gets the same system prompt.
 */
export async function buildTurnPromptLayouts(): Promise<TurnPromptLayouts> {
  // One after another: when two imports of a module that a test mocks with
  // `vi.doMock` start at once, Vitest gives the second one the real module.
  // Tests that act as a `juniorNitro()` build mock `#junior/system-prompts`.
  const slack = await platformPromptLayout("slack");
  const local = await platformPromptLayout("local");
  return { slack, local };
}

/**
 * Gives the prompt layout of a claimed Turn: the layout of the platform of
 * its Conversation's Location, which Delivery sends the replies to. A Turn
 * with no Location gets the `local` layout. It only picks one of `layouts`.
 */
export function turnPromptLayout(
  { executor }: Pick<EngineContext, "executor">,
  layouts: TurnPromptLayouts,
) {
  return async (turn: ClaimedTurn): Promise<PromptLayout> => {
    const [conversation] = await executor
      .db()
      .select({ location: juniorConversations.location })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, turn.conversationId))
      .limit(1);
    const location = conversation?.location
      ? locationSchema.parse(conversation.location)
      : undefined;
    return layouts[location?.provider ?? "local"];
  };
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
