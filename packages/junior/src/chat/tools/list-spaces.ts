import * as z from "zod";
import { getDashboardSpaceLink } from "@/chat/dashboard-link";
import { listSpaces, type Space } from "@/chat/spaces/store";
import { SPACES_TOOL_SOURCE } from "@/chat/spaces/tool-source";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

const spaceMatchSchema = z
  .object({
    id: z
      .string()
      .describe("Pass it as the `space` of moveConversationToSpace."),
    name: z.string(),
    description: z.string().optional(),
    visibility: z.enum(["public", "private"]),
    member: z.boolean().describe("The person is a member of the Space."),
    url: z.string().url().optional().describe("Link to the Space."),
  })
  .strict();

export const listSpacesToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: SPACES_TOOL_SOURCE,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  description:
    "List the Spaces that the person can see, by name: every public Space, and this conversation's own Space. A private Space shows only inside it. Archived Spaces are left out.",
  inputSchema: z
    .object({
      membership: z
        .enum(["all", "member"])
        .optional()
        .describe(
          "member: only the Spaces that the person is a member of. Omitted or all: every Space that they can see.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    spaces: z.array(spaceMatchSchema),
  }),
});

function spaceMatch(space: Space): z.output<typeof spaceMatchSchema> {
  const url = getDashboardSpaceLink(space.id);
  return {
    id: space.id,
    name: space.name,
    ...(space.description ? { description: space.description } : undefined),
    visibility: space.visibility,
    member: space.viewerIsMember,
    ...(url ? { url } : undefined),
  };
}

/**
 * Build the tool that lists the Spaces that the Turn's person can see. A
 * private Space's data stays with its members, so its name and ID reach
 * only a Conversation in it (`policies/conversation-access.md`).
 */
export function createListSpacesTool(
  context: Pick<ToolRuntimeContext, "resolveActorIdentity" | "spaceId">,
) {
  return zodTool({
    ...listSpacesToolDefinition,
    async execute(input) {
      const user = (await context.resolveActorIdentity?.())?.user;
      if (!user) {
        throw new ToolInputError(
          "This person has no linked User, so they have no Spaces. No change to the call can fix this.",
        );
      }
      const spaces = await listSpaces(user.id, {
        archived: false,
        membership: input.membership ?? "all",
      });
      return {
        spaces: spaces
          .filter(
            (space) =>
              space.visibility === "public" || space.id === context.spaceId,
          )
          .map(spaceMatch),
      };
    },
  });
}
