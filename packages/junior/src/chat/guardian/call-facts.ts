import type { CallFacts } from "@sentry/junior-plugin-api";
import { listCodeChanges } from "@/chat/code/store";
import { getDb } from "@/chat/db";
import type { Call } from "@/chat/guardian/guardian";

/**
 * The call that Guardian reviews, from one plugin tool's facts. Core, not
 * the plugin, decides whether this work created the target: it matches the
 * target's code change against its own code-change records for the work.
 */
export async function callFromFacts(
  facts: CallFacts,
  args: {
    /** The plugin whose code-change records the target is in. */
    provider: string;
    conversationIds(): Promise<string[]>;
  },
): Promise<Call> {
  const { target, ...call } = facts;
  if (!target) return call;
  const { codeChange, ...rest } = target;
  const createdByThisWork =
    codeChange !== undefined &&
    (
      await listCodeChanges(getDb(), args.provider, {
        conversationIds: await args.conversationIds(),
        repository: {
          name: codeChange.repository,
          numbers: [codeChange.number],
        },
      })
    ).length > 0;
  return { ...call, target: { ...rest, createdByThisWork } };
}
