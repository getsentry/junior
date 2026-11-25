import * as z from "zod";
import { configValueSchema } from "@/chat/configuration/types";
import { getConversationStore } from "@/chat/db";
import {
  listSpaceConfiguration,
  setSpaceConfiguration,
  unsetSpaceConfiguration,
} from "@/chat/spaces/configuration";
import { readSpace } from "@/chat/spaces/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

const SPACES_TOOL_SOURCE = {
  id: "spaces",
  description: "Change the settings of this conversation's Space.",
} as const;

export const setSpaceConfigurationToolDefinition = zodToolDefinition({
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
    "Set or remove one configuration value of this conversation's Space, such as a default repository or Sentry org. It takes the same keys as a channel's configuration, and it applies to every conversation in the Space, over the channel and install defaults. Only a member of the Space changes it. Returns every value the Space sets after the change.",
  inputSchema: z
    .object({
      key: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("The configuration key, such as `github.repo`."),
      value: configValueSchema
        .nullable()
        .describe(
          "The new value. null removes the key, so the channel or install default applies again.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    space: z.object({ id: z.string(), name: z.string() }),
    entries: z
      .array(z.object({ key: z.string(), value: configValueSchema }))
      .describe("Every value the Space sets, by key."),
  }),
});

async function readConversationSpaceId(
  conversationId: string,
): Promise<string | undefined> {
  const store = getConversationStore();
  const conversation = await store.get({ conversationId });
  const rootId = conversation?.rootConversationId;
  // A child is in the Space of its root.
  const root =
    rootId && rootId !== conversationId
      ? await store.get({ conversationId: rootId })
      : conversation;
  return root?.spaceId;
}

/**
 * Build the tool that changes the configuration of the current
 * Conversation's Space for the person who started the Turn. The actor comes
 * from the runtime, and only a member of the Space changes it. Contract:
 * `chat/spaces/configuration.ts`.
 */
export function createSetSpaceConfigurationTool(
  context: Pick<ToolRuntimeContext, "conversationId" | "resolveActorIdentity">,
) {
  return zodTool({
    ...setSpaceConfigurationToolDefinition,
    async execute(input) {
      const user = (await context.resolveActorIdentity?.())?.user;
      if (!user) {
        throw new ToolInputError(
          "This person has no linked User, so they cannot change a Space. No change to the call can fix this.",
        );
      }
      const spaceId = await readConversationSpaceId(context.conversationId);
      const space = spaceId ? await readSpace(user.id, spaceId) : undefined;
      if (!space) {
        throw new ToolInputError(
          "This conversation is in no Space, so it has no Space settings to change.",
        );
      }
      if (!space.viewerIsMember) {
        throw new ToolInputError(
          `This person is not a member of ${space.name}, so they cannot change its settings. They can join it first.`,
        );
      }
      if (input.value === null) {
        await unsetSpaceConfiguration(space.id, input.key);
      } else {
        const error = await setSpaceConfiguration({
          key: input.key,
          spaceId: space.id,
          updatedByUserId: user.id,
          value: input.value,
        });
        if (error) throw new ToolInputError(error);
      }
      const entries = await listSpaceConfiguration(space.id);
      return {
        space: { id: space.id, name: space.name },
        entries: entries.map(({ key, value }) => ({ key, value })),
      };
    },
  });
}
