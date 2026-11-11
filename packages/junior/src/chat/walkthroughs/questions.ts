/**
 * Questions about a Walkthrough: one private, hidden Conversation per
 * reviewer and version. Its Turns read the Walkthrough and its code changes
 * through `readWalkthrough` and `readWalkthroughCode`, and every other tool
 * is disabled.
 */
import { and, eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
  webActorFromUser,
  type WebMessageAccepted,
} from "@/chat/conversations/web-input";
import { getConversationStore, getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  juniorWalkthroughQuestions,
  juniorWalkthroughVersions,
} from "@/db/schema";
import type { WalkthroughCodeChange } from "@/db/schema/walkthroughs";
import type { WalkthroughVersion } from "./store";

/** Skill that every question Turn runs. */
export const WALKTHROUGH_QUESTIONS_SKILL = "walkthrough-questions";

/**
 * The Walkthrough that a question Turn answers about. Only the Turn worker
 * sets it, from the Conversation's row, so the model never names a version.
 */
export type WalkthroughQuestions = {
  versionId: string;
  provider: string;
  repository: string;
  /** Bottom first. */
  layers: WalkthroughCodeChange[];
  documentKey: string;
};

/** The viewer's questions Conversation for one version, if they asked. */
export async function readWalkthroughQuestionsConversationId(input: {
  versionId: string;
  userId: string;
}): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ conversationId: juniorWalkthroughQuestions.conversationId })
    .from(juniorWalkthroughQuestions)
    .where(
      and(
        eq(juniorWalkthroughQuestions.versionId, input.versionId),
        eq(juniorWalkthroughQuestions.userId, input.userId),
      ),
    );
  return row?.conversationId;
}

/**
 * Ask one question about a ready version. The first question creates the
 * viewer's Conversation; later ones add to it. The row is written first, so
 * lists never show the Conversation.
 */
export async function askWalkthroughQuestion(input: {
  version: WalkthroughVersion;
  viewer: User;
  message: string;
  idempotencyKey: string;
  queue: ConversationWorkQueue;
}): Promise<WebMessageAccepted> {
  const actor = webActorFromUser(input.viewer);
  const conversationId = createConversationId({
    actorEmail: actor.email ?? input.viewer.email,
    idempotencyKey: `walkthrough-questions:${input.version.id}`,
  });
  await getDb()
    .insert(juniorWalkthroughQuestions)
    .values({
      versionId: input.version.id,
      userId: input.viewer.id,
      conversationId,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  const top = input.version.codeChanges.at(-1);
  return await appendAndEnqueueWebMessage(
    {
      actor,
      conversationId,
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      rootTitle: top
        ? `Questions about the Walkthrough of #${top.number}`
        : "Questions about a Walkthrough",
      rootVisibility: "private",
    },
    { conversationStore: getConversationStore(), queue: input.queue },
  );
}

/** The Walkthrough that a Conversation's questions are about, if any. */
export async function readWalkthroughQuestions(
  conversationId: string,
): Promise<WalkthroughQuestions | undefined> {
  const [row] = await getDb()
    .select({
      versionId: juniorWalkthroughVersions.id,
      provider: juniorWalkthroughVersions.provider,
      repository: juniorWalkthroughVersions.repository,
      layers: juniorWalkthroughVersions.codeChanges,
      documentKey: juniorWalkthroughVersions.documentKey,
    })
    .from(juniorWalkthroughQuestions)
    .innerJoin(
      juniorWalkthroughVersions,
      eq(juniorWalkthroughVersions.id, juniorWalkthroughQuestions.versionId),
    )
    .where(eq(juniorWalkthroughQuestions.conversationId, conversationId));
  // Only a ready version has a document, and only a ready one takes questions.
  if (!row?.documentKey) return undefined;
  return { ...row, documentKey: row.documentKey };
}
