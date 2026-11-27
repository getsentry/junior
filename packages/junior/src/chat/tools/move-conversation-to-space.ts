import { HTTPException } from "hono/http-exception";
import * as z from "zod";
import { setConversationSpaceForViewer } from "@/api/conversations/space";
import { SPACES_TOOL_SOURCE } from "@/chat/spaces/tool-source";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

export const moveConversationToSpaceToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: SPACES_TOOL_SOURCE,
  executionMode: "sequential",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  approvalMode: "review",
  description:
    "Move a top-level conversation into a Space, to another Space, or out of its Space, when the person asks for it. Its child conversations move with it. The person must be a member of the Space it leaves and of the Space it joins. Returns the conversation's Space after the move.",
  inputSchema: z
    .object({
      conversation_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "The top-level conversation to move. Omit it to move this conversation.",
        ),
      space: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .optional()
        .describe(
          "The Space to move it to: its ID, or a dashboard link that ends in /spaces/<id>. Omit it for the Space that this conversation is in. null takes it out of its Space. Names are not unique, so ask the person for the link when you have neither.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    conversation_id: z.string(),
    space: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .describe("The conversation's Space now, or null when it has none."),
  }),
});

// Space names are not unique, so the tool takes only an ID, or the ID at
// the end of a dashboard Space link.
function parseSpaceId(space: string): string {
  const id = space.match(/\/spaces\/([^/?#]+)\/?(?:[?#].*)?$/)?.[1] ?? space;
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) {
    throw new ToolInputError(
      `"${space}" is not a Space ID or a link to a Space. Ask the person for the Space's link.`,
    );
  }
  return parsed.data;
}

// null takes the Conversation out of its Space. With no Space named, a Lead
// moves it into its own Space, so that ID comes from the runtime, not from
// one that the model copies.
function targetSpaceId(
  space: string | null | undefined,
  ownSpaceId: string | undefined,
): string | null {
  if (space === null) return null;
  if (space !== undefined) return parseSpaceId(space);
  if (!ownSpaceId) {
    throw new ToolInputError(
      "This conversation is in no Space. Pass the Space's ID or link, or ask the person for the link.",
    );
  }
  return ownSpaceId;
}

/**
 * Build the tool that moves a top-level Conversation into, out of, or
 * between Spaces for the person who started the Turn. The registry offers
 * it only to a person's Turn, so a move always comes from a person's
 * request. The actor comes from the runtime, and the move uses the same
 * checks as the dashboard's Move to Space: `api/conversations/space.ts`.
 */
export function createMoveConversationToSpaceTool(
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "resolveActorIdentity" | "spaceId"
  >,
) {
  return zodTool({
    ...moveConversationToSpaceToolDefinition,
    async execute(input) {
      const user = (await context.resolveActorIdentity?.())?.user;
      if (!user) {
        throw new ToolInputError(
          "This person has no linked User, so they cannot move a conversation. No change to the call can fix this.",
        );
      }
      const conversationId = input.conversation_id ?? context.conversationId;
      try {
        const spaceId = targetSpaceId(input.space, context.spaceId);
        const result = await setConversationSpaceForViewer(
          user,
          conversationId,
          { spaceId },
        );
        return { conversation_id: conversationId, space: result.space };
      } catch (error) {
        // The move's checks speak to the person: a 404, a missing
        // membership, or a conversation that cannot move.
        if (error instanceof HTTPException && error.status < 500) {
          throw new ToolInputError(error.message);
        }
        throw error;
      }
    },
  });
}
