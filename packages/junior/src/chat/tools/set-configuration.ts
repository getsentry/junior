import * as z from "zod";
import { isUserActor } from "@/chat/actor";
import { configValueSchema } from "@/chat/configuration/types";
import {
  validateConfigKey,
  validateConfigValue,
} from "@/chat/configuration/validation";
import {
  listSpaceConfiguration,
  readConversationSpaceId,
  setSpaceConfiguration,
  unsetSpaceConfiguration,
} from "@/chat/spaces/configuration";
import { getConfigDefaults } from "@/chat/configuration/defaults";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { readSpace } from "@/chat/spaces/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

const CONFIGURATION_TOOL_SOURCE = {
  id: "configuration",
  description:
    "Change the configuration of this conversation's Slack channel and Space.",
} as const;

const entriesSchema = z
  .array(z.object({ key: z.string(), value: configValueSchema }))
  .describe("Every value that it sets, by key.");

export const setConfigurationToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: CONFIGURATION_TOOL_SOURCE,
  executionMode: "sequential",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  approvalMode: "review",
  description:
    "Set or remove one configuration value, such as a default repository or Sentry org, everywhere this conversation gets its configuration: its Slack channel, its Space, or both. The Space's value wins over the channel's, and both win over install defaults. Only a member of the Space changes the Space's value. Returns the values each one sets after the change.",
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
        .describe("The new value. null removes the key, so a default applies."),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({
    channel: z
      .object({ entries: entriesSchema })
      .optional()
      .describe("The Slack channel's values. Unset outside a channel."),
    space: z
      .object({ id: z.string(), name: z.string(), entries: entriesSchema })
      .optional()
      .describe("The Space's values. Unset outside a Space."),
    warning: z
      .string()
      .optional()
      .describe(
        "Set when no installed plugin reads the key, with the keys that it may mean.",
      ),
  }),
});

/**
 * Build the tool that changes the configuration of the current
 * Conversation: its Slack channel's, read from the Run, and its Space's,
 * read when the tool runs. It changes every one that applies, and checks
 * them all before it writes any. The actor comes from the runtime, and only
 * a member of the Space changes the Space. Contracts:
 * `chat/configuration/service.ts` and `chat/spaces/configuration.ts`.
 */
export function createSetConfigurationTool(
  context: Pick<
    ToolRuntimeContext,
    | "actor"
    | "configuration"
    | "conversationId"
    | "locationConfiguration"
    | "resolveActorIdentity"
  >,
) {
  return zodTool({
    ...setConfigurationToolDefinition,
    async execute(input) {
      const { key, value } = input;
      const location = context.locationConfiguration;
      // A move earlier in the Turn can change the Space, so read it now.
      const spaceId = await readConversationSpaceId(context.conversationId);
      if (!location && !spaceId) {
        throw new ToolInputError(
          "This conversation has no Slack channel or Space, so it has no configuration to change.",
        );
      }
      const error =
        validateConfigKey(key) ??
        (value === null ? undefined : validateConfigValue(value));
      if (error) throw new ToolInputError(error);
      const space = spaceId
        ? await readMemberSpace(context, spaceId)
        : undefined;

      if (space) {
        if (value === null) await unsetSpaceConfiguration(space.id, key);
        else {
          const spaceError = await setSpaceConfiguration({
            key,
            spaceId: space.id,
            updatedByUserId: space.userId,
            value,
          });
          if (spaceError) throw new ToolInputError(spaceError);
        }
      }
      if (location) {
        if (value === null) await location.unset(key);
        else {
          await location.set({
            key,
            value,
            updatedBy: isUserActor(context.actor)
              ? context.actor.userId
              : undefined,
            source: "setConfiguration",
          });
        }
      }
      // Later tools in this Turn read the new value. A removed key falls
      // back to the install default, as it does in the next Turn.
      if (context.configuration) {
        const next = value ?? getConfigDefaults()[key];
        if (next === undefined) delete context.configuration[key];
        else context.configuration[key] = next;
      }

      const entries = (rows: { key: string; value: unknown }[]) =>
        rows.map((row) => ({
          key: row.key,
          value: configValueSchema.parse(row.value),
        }));
      const warning = value === null ? undefined : unknownKeyWarning(key);
      return {
        ...(warning ? { warning } : undefined),
        ...(location
          ? { channel: { entries: entries(await location.list()) } }
          : undefined),
        ...(space
          ? {
              space: {
                id: space.id,
                name: space.name,
                entries: entries(await listSpaceConfiguration(space.id)),
              },
            }
          : undefined),
      };
    },
  });
}

// A typo still saves, the same as a key that a plugin adds later, but the
// warning names the keys that the installed plugins read.
function unknownKeyWarning(key: string): string | undefined {
  const knownKeys = pluginCatalogRuntime
    .getProviders()
    .flatMap((plugin) => [...plugin.manifest.configKeys]);
  if (knownKeys.includes(key)) return undefined;
  const prefix = key.includes(".") ? key.slice(0, key.indexOf(".") + 1) : "";
  const suggestions = prefix
    ? knownKeys.filter((known) => known.startsWith(prefix))
    : [];
  return `No installed plugin reads "${key}". ${
    suggestions.length > 0
      ? `Known keys with prefix "${prefix}": ${suggestions.join(", ")}`
      : `Known keys: ${knownKeys.join(", ")}`
  }`;
}

async function readMemberSpace(
  context: Pick<ToolRuntimeContext, "resolveActorIdentity">,
  spaceId: string,
) {
  const user = (await context.resolveActorIdentity?.())?.user;
  if (!user) {
    throw new ToolInputError(
      "This person has no linked User, so they cannot change this conversation's Space. No change to the call can fix this.",
    );
  }
  const space = await readSpace(user.id, spaceId);
  if (!space) {
    throw new ToolInputError(
      "This conversation's Space is gone, so its configuration cannot change.",
    );
  }
  if (!space.viewerIsMember) {
    throw new ToolInputError(
      `This person is not a member of ${space.name}, so they cannot change its configuration. They can join it first.`,
    );
  }
  return { id: space.id, name: space.name, userId: user.id };
}
