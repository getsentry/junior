/**
 * Start a Walkthrough generation and connect its hidden Conversation to the
 * version it generates.
 *
 * A generation is an ordinary web Turn in a public root Conversation whose
 * first message invokes the walkthrough skill. The version row names that
 * Conversation, so the Turn worker finds the version by Conversation id and
 * lists hide the Conversation.
 */
import { randomUUID } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import {
  createAndEnqueueConversation,
  createConversationId,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { readCodeChangeRootConversations } from "@/chat/code/store";
import { getConversationStore, getDb } from "@/chat/db";
import {
  canReadCodeChanges,
  readPluginCodeChangeStack,
} from "@/chat/plugins/code-change-hooks";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  readWalkthroughQuestions,
  type WalkthroughQuestions,
} from "./questions";
import type { WalkthroughGeneration } from "./submit-tool";
import {
  failWalkthroughVersion,
  findWalkthroughParent,
  getGeneratingWalkthroughVersion,
  startWalkthroughVersion,
  walkthroughSnapshotKey,
  type WalkthroughVersion,
} from "./store";

/**
 * The public root Conversations that code changes in the stack came from,
 * most shared first, then by the lowest layer. Junior links each code change
 * it opens to its Conversations; a sub-agent's root is the Conversation where
 * a person asked for the work. A private root stays out: the public
 * generation Conversation cannot read it.
 */
async function findSourceConversationIds(input: {
  provider: string;
  repository: string;
  numbers: number[];
}): Promise<string[]> {
  const links = await readCodeChangeRootConversations(getDb(), input);
  const roots = new Map<string, { layers: Set<number>; lowest: number }>();
  for (const link of links) {
    const layer = input.numbers.indexOf(link.number);
    const root = roots.get(link.rootConversationId) ?? {
      layers: new Set<number>(),
      lowest: layer,
    };
    root.layers.add(layer);
    root.lowest = Math.min(root.lowest, layer);
    roots.set(link.rootConversationId, root);
  }
  const ranked = [...roots.entries()]
    .sort(
      ([, a], [, b]) => b.layers.size - a.layers.size || a.lowest - b.lowest,
    )
    .map(([conversationId]) => conversationId);
  const conversations = await Promise.all(
    ranked.map((conversationId) =>
      getConversationStore().get({ conversationId }),
    ),
  );
  return ranked.filter(
    (_, index) => conversations[index]?.visibility === "public",
  );
}

/** The first message of a generation Conversation. */
function generationInstruction(
  version: WalkthroughVersion,
  otherSourceConversationIds: string[],
): string {
  return [
    "$walkthrough",
    "",
    `Repository: ${version.repository} (${version.provider})`,
    "Code changes, bottom first:",
    ...version.codeChanges.map(
      (change) =>
        `- #${change.number} ${change.url} base ${change.baseSha} head ${change.headSha}`,
    ),
    ...(version.sourceConversationId
      ? [`Source Conversation: ${version.sourceConversationId}`]
      : []),
    ...otherSourceConversationIds.map(
      (conversationId) => `Other source Conversation: ${conversationId}`,
    ),
    ...(version.parentVersionId
      ? ["", "This Turn updates the previous version of this Walkthrough."]
      : []),
  ].join("\n");
}

/**
 * Start a Walkthrough of the stack that contains one code change. A second
 * request for the same stack at the same commits gets the running or ready
 * version. When the stack has new commits since a ready version, the new
 * version updates that one. Returns undefined when no plugin reads the
 * provider's code changes, or the provider does not know the code change.
 */
export async function startWalkthrough(input: {
  viewer: User;
  provider: string;
  repository: string;
  number: number;
  queue: ConversationWorkQueue;
}): Promise<WalkthroughVersion | undefined> {
  if (!canReadCodeChanges(input.provider)) return undefined;
  const stack = await readPluginCodeChangeStack({
    provider: input.provider,
    repository: input.repository,
    number: input.number,
    signal: AbortSignal.timeout(30_000),
  });
  if (!stack) return undefined;

  const actor = webActorFromUser(input.viewer);
  const found = await findWalkthroughParent({
    provider: input.provider,
    repository: input.repository,
    numbers: stack.codeChanges.map((change) => change.number),
  });
  // The same snapshot reuses the parent itself, so it is not its own parent.
  const parent =
    found && found.snapshotKey !== walkthroughSnapshotKey(stack.codeChanges)
      ? found
      : undefined;
  const sourceConversationIds = await findSourceConversationIds({
    provider: input.provider,
    repository: input.repository,
    numbers: stack.codeChanges.map((change) => change.number),
  });
  // An update keeps the parent's messages, so it keeps the parent's source
  // and its read check, even after that source turned private.
  const sourceConversationId =
    parent?.sourceConversationId ?? sourceConversationIds[0];
  const idempotencyKey = `walkthrough:${randomUUID()}`;
  const { version, started } = await startWalkthroughVersion({
    provider: input.provider,
    repository: input.repository,
    codeChanges: stack.codeChanges,
    generationConversationId: createConversationId({
      actorEmail: actor.email ?? input.viewer.email,
      idempotencyKey,
    }),
    createdByUserId: input.viewer.id,
    ...(sourceConversationId ? { sourceConversationId } : undefined),
    ...(parent ? { parentVersionId: parent.id } : undefined),
  });
  if (!started) return version;

  try {
    await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey,
        message: generationInstruction(
          version,
          sourceConversationIds.filter(
            (conversationId) => conversationId !== version.sourceConversationId,
          ),
        ),
        title: `Walkthrough of #${input.number}`,
        visibility: "public",
      },
      {
        conversationStore: getConversationStore(),
        queue: input.queue,
      },
    );
  } catch (error) {
    await failWalkthroughVersion({
      id: version.id,
      reason: "The generation could not start.",
    });
    throw error;
  }
  return version;
}

/**
 * The Walkthrough work of a Conversation's Turn, if any: a generation and
 * the step that ends it, or the questions it answers. A generation Turn that
 * ends without a stored Walkthrough fails its version, so the next click can
 * retry.
 */
export async function readWalkthroughRun(conversationId: string): Promise<
  | {
      generation?: WalkthroughGeneration;
      questions?: WalkthroughQuestions;
      finish?: () => Promise<void>;
    }
  | undefined
> {
  const [version, questions] = await Promise.all([
    getGeneratingWalkthroughVersion(conversationId),
    readWalkthroughQuestions(conversationId),
  ]);
  if (questions) return { questions };
  if (!version) return undefined;
  return {
    generation: {
      versionId: version.id,
      provider: version.provider,
      repository: version.repository,
      layers: version.codeChanges,
      modelId: botConfig.modelId,
      ...(version.parentVersionId
        ? { parentVersionId: version.parentVersionId }
        : undefined),
      ...(version.sourceConversationId
        ? { sourceConversationId: version.sourceConversationId }
        : undefined),
    },
    finish: () =>
      failWalkthroughVersion({
        id: version.id,
        reason: "The Turn ended without a Walkthrough.",
      }),
  };
}
