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
import { getConversationStore } from "@/chat/db";
import {
  canReadCodeChanges,
  readPluginCodeChangeStack,
} from "@/chat/plugins/code-change-hooks";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { WalkthroughGeneration } from "./submit-tool";
import {
  failWalkthroughVersion,
  getGeneratingWalkthroughVersion,
  startWalkthroughVersion,
  type WalkthroughVersion,
} from "./store";

const CONVERSATION_ID_MARKER = /<!-- junior-conversation-id:([^\s>]+) -->/;

/**
 * The public Conversation that opened one of the code changes. Junior writes
 * this marker in the footer of a pull request it opens. A private
 * Conversation stays out: the public generation Conversation cannot read it.
 */
async function findSourceConversationId(
  bodies: string[],
): Promise<string | undefined> {
  for (const body of bodies) {
    const encoded = CONVERSATION_ID_MARKER.exec(body)?.[1];
    if (!encoded) continue;
    let conversationId: string;
    try {
      conversationId = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    const conversation = await getConversationStore().get({ conversationId });
    if (conversation?.visibility === "public") return conversationId;
  }
  return undefined;
}

/** The first message of a generation Conversation. */
function generationInstruction(version: WalkthroughVersion): string {
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
  ].join("\n");
}

/**
 * Start a Walkthrough of the stack that contains one code change. A second
 * request for the same stack at the same commits gets the running or ready
 * version. Returns undefined when no plugin reads the provider's code
 * changes, or the provider does not know the code change.
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
  const sourceConversationId = await findSourceConversationId(
    stack.codeChanges.map((change) => change.body),
  );
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
  });
  if (!started) return version;

  try {
    await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey,
        message: generationInstruction(version),
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
 * The Walkthrough that a Conversation's Turn generates, if any, and the step
 * that ends it. A Turn that ends without a stored Walkthrough fails its
 * version, so the next click can retry.
 */
export async function readWalkthroughRun(conversationId: string): Promise<
  | {
      generation: WalkthroughGeneration;
      finish: () => Promise<void>;
    }
  | undefined
> {
  const version = await getGeneratingWalkthroughVersion(conversationId);
  if (!version) return undefined;
  return {
    generation: {
      versionId: version.id,
      provider: version.provider,
      repository: version.repository,
      layers: version.codeChanges,
      modelId: botConfig.modelId,
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
