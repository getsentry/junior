import { HTTPException } from "hono/http-exception";
import * as z from "zod";
import { setConversationSpaceForViewer } from "@/api/conversations/space";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

const SPACES_TOOL_SOURCE = {
  id: "spaces",
  description: "Move a conversation into, out of, or between Spaces.",
} as const;

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
        .describe(
          "The Space to move it to: its ID, or a dashboard link to it that ends in /spaces/<id>. Names are not unique, so ask the person for the link when you do not have either. null takes the conversation out of its Space.",
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

/**
 * Build the tool that moves a top-level Conversation into, out of, or
 * between Spaces for the person who started the Turn. The registry offers
 * it only to a person's Turn, so a move always comes from a person's
 * request. The actor comes from the runtime, and the move uses the same
 * checks as the dashboard's Move to Space: `api/conversations/space.ts`.
 */
export function createMoveConversationToSpaceTool(
  context: Pick<ToolRuntimeContext, "conversationId" | "resolveActorIdentity">,
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
        const spaceId = input.space === null ? null : parseSpaceId(input.space);
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
