import type { ActionFacts } from "@sentry/junior-plugin-api";
import { listCodeChanges } from "@/chat/code/store";
import { getDb } from "@/chat/db";
import type { ActionDescription } from "@/chat/tool-support/definition";

/**
 * The action that Guardian reviews, from one plugin tool's facts. Core, not
 * the plugin, decides whether this work created the target: it matches the
 * target's code change against its own code-change records for the work.
 */
export async function actionFromFacts(
  facts: ActionFacts,
  args: {
    /** The plugin whose code-change records the target is in. */
    provider: string;
    conversationIds(): Promise<string[]>;
  },
): Promise<ActionDescription> {
  const { target, ...rest } = facts;
  if (!target) return rest;
  const { codeChange, ...fields } = target;
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
  return { ...rest, target: { ...fields, createdByThisWork } };
}
