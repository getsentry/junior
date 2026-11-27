import type {
  CallDescription,
  DescribeContext,
} from "@sentry/junior-plugin-api";
import { listCodeChanges } from "@/chat/code/store";
import { getDb } from "@/chat/db";
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
