import type {
  CallDescription,
  DescribeContext,
  DescribeReadContext,
} from "@sentry/junior-plugin-api";
import { listCodeChanges } from "@/chat/code/store";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { createPluginEgress } from "@/chat/egress/plugin";
import { createPluginCache } from "@/chat/plugins/cache";

// Facts about a target, such as a repository's visibility, do not depend on
// who asked, so they are read as Junior's own system account.
const GUARDIAN_FACTS_ACTOR = { platform: "system", name: "guardian" } as const;

/**
 * What one plugin may read while it describes a call or a URL: its cache,
 * and provider reads as Junior's system account. A read never asks anyone
 * to authorize.
 */
export function describeReadContext(plugin: string): DescribeReadContext {
  return {
    cache: createPluginCache(plugin),
    egress: createPluginEgress({
      credentialContext: credentialContextForActor(GUARDIAN_FACTS_ACTOR),
      pluginAuth: { async handleAuthRequired() {} },
    }),
  };
}
import type { ActionDescription } from "@/chat/tool-support/definition";

/**
 * What core answers for one plugin's `describe`. Core, not the plugin,
 * says whether this work created a pull request: it reads its own
 * code-change records for the work's Conversations.
 */
export function describeContext(args: {
  /** The plugin whose code-change records hold the pull request. */
  provider: string;
  conversationIds(): Promise<string[]>;
}): DescribeContext {
  return {
    ...describeReadContext(args.provider),
    async isOwnPullRequest(repo, number) {
      const changes = await listCodeChanges(getDb(), args.provider, {
        conversationIds: await args.conversationIds(),
        repository: { name: repo, numbers: [number] },
      });
      return changes.length > 0;
    },
  };
}

/** The action that Guardian reviews, from one plugin call's description. */
export function actionFromDescription(
  description: CallDescription,
): ActionDescription {
  const { ref, audience, advice, reason } = description;
  return {
    target: { ref, audience },
    ...(advice === "allow"
      ? { advice: { decision: "allow", ...(reason ? { reason } : undefined) } }
      : undefined),
  };
}
