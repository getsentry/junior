import { getConfigDefaults } from "@/chat/configuration/defaults";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import { readConversationSpaceConfiguration } from "@/chat/spaces/configuration";

/**
 * Resolve the configuration of a Conversation's Turn. Later layers win: the
 * install defaults, the Run's own values, the Slack channel, then the Space
 * of the Conversation's root. An explicit target in the request wins over
 * all of them. The model applies that, because only it reads the request.
 */
export async function resolveConversationConfiguration(args: {
  configuration?: Record<string, unknown> | undefined;
  conversationId: string;
  locationConfiguration?: LocationConfigurationService | undefined;
}): Promise<Record<string, unknown>> {
  const [location, space] = await Promise.all([
    args.locationConfiguration?.resolveValues() ?? {},
    readConversationSpaceConfiguration(args.conversationId),
  ]);
  return {
    ...getConfigDefaults(),
    ...args.configuration,
    ...location,
    ...space,
  };
}
