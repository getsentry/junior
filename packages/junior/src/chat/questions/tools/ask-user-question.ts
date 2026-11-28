import { randomUUID } from "node:crypto";
import * as z from "zod";
import {
  reactToConversationChange,
  type ConversationChangeServices,
} from "@/chat/conversations/change-reactions";
import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import { getDb } from "@/chat/db";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { readAskScope, requireAskedPeople, type AskScope } from "../ask-scope";
import {
  activeParticipantUserIds,
  automationCreatorUserId,
  resolveAssignees,
  type FindMentionedUserId,
  type ResolvedAssignees,
} from "../assignees";
import { askQuestionId } from "../request";
import { getQuestion, insertQuestion } from "../store";
import {
  assigneesSchema,
  questionContent,
  questionsSchema,
} from "../tool-input";

// Unlike Claude Code's AskUserQuestion, the call returns before the person
// answers, so the result says that no answer exists yet. A model that reads
// a finished call as an answer invents one.
const ASKED_NEXT_STEP = `The questions were sent. There is no answer yet. The answer arrives in a later Turn as a \`<question-answer>\` with the id of this call; a dismiss comes as a note. Do not guess the answer. If your next step needs it, end the Turn now with \`${NO_REPLY_TOOL_NAME}\` and no text: the card is your reply. Otherwise, finish the work that does not need it, then end the Turn.`;

/** The Turn context that the ask tool reads. */
type AskUserQuestionToolContext = Pick<
  ToolRuntimeContext,
  "actorIsApp" | "conversationId" | "resolveActorIdentity" | "source" | "turnId"
>;

/** What app setup gives the ask tool. */
interface AskUserQuestionToolServices extends ConversationChangeServices {
  findMentionedUserId: FindMentionedUserId;
}

/**
 * Pick who is asked when the agent names nobody: the Actor's User, else the
 * Automation's creator, else the Conversation's active Participants. A Slack
 * Actor without a Junior User gets nobody, so the agent can still ask and
 * any person in the thread can answer on the card.
 */
async function defaultAssignees(
  scope: AskScope,
  conversationId: string,
): Promise<ResolvedAssignees> {
  const userId =
    scope.user?.id ??
    (scope.automationId
      ? await automationCreatorUserId(getDb(), scope.automationId)
      : undefined);
  if (userId) return { everyone: false, userIds: [userId] };
  if (scope.actorIsPerson) return { everyone: false, userIds: [] };
  const participants = await activeParticipantUserIds(getDb(), conversationId);
  return {
    everyone: false,
    userIds: participants.filter((id) => id !== scope.appUserId),
  };
}

export const askUserQuestionToolDefinition = zodToolDefinition({
  description:
    "Ask a person one or more questions with choices when you need their decision or input before you can go on. This is how you ask a person anything. Do not use it to report a result, an error, or an action that failed or was refused: say that in your reply. The questions go in their Inbox and, in a Slack thread, show as a card. The person answers in a later Turn, not in this call. Returns the question id and what to do until the answer comes.",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: z
    .object({
      questions: questionsSchema,
      assignees: assigneesSchema
        .nullable()
        .optional()
        .describe(
          "Who is asked. Omit for the person in this Turn, else the Automation creator in an Automation run, else the people still subscribed to the Conversation.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema,
});

/**
 * Create the tool that asks a person questions. It stores the question in
 * the Conversation; features such as the Inbox show it after the commit.
 */
export function createAskUserQuestionTool(
  context: AskUserQuestionToolContext,
  services: AskUserQuestionToolServices,
) {
  return zodTool({
    ...askUserQuestionToolDefinition,
    execute: async (input, options) => {
      const content = questionContent(input.questions);
      const db = getDb();
      const scope = await readAskScope(context);
      // Each call asks a new question. A retry of the same tool call keeps
      // the same question id, so it cannot ask twice. Its answer names the
      // call, so a call without an id gets none.
      const id = options.toolCallId
        ? askQuestionId(context.conversationId, options.toolCallId)
        : `question:${randomUUID()}`;
      const asked = input.assignees
        ? await resolveAssignees(
            db,
            input.assignees,
            scope.tenant,
            services.findMentionedUserId,
          )
        : await defaultAssignees(scope, context.conversationId);
      // Only a person who is asked counts the question as waiting on them.
      // A Turn without a person, such as one that an app asked for, has
      // nobody to show it to, so it must name someone.
      if (
        !asked.everyone &&
        asked.userIds.length === 0 &&
        !scope.actorIsPerson
      ) {
        throw new ToolInputError(
          "Only people answer questions, and this one would have none: this Turn has no person, and no default assignee has a User. Set `assignees` to the person who should answer, or reply in text.",
        );
      }
      // The question is as private as the Conversation that asks it.
      await requireAskedPeople({
        assignees: asked,
        automationId: scope.automationId,
        conversationIds: [context.conversationId],
        isPrivate: scope.inPrivateConversation,
        user: scope.user,
      });
      const nowMs = Date.now();
      // A Turn replays a call that committed before its result was saved.
      // Its open question goes on, and its reactions run again.
      const isNew = await insertQuestion(db, {
        content,
        conversationId: context.conversationId,
        id,
        nowMs,
        turnId: context.turnId,
      });
      if (!isNew && (await getQuestion(db, id))?.closedAt) {
        throw new ToolInputError(
          "This tool call already asked its question, and it is closed. Ask again with a new call.",
        );
      }
      await reactToConversationChange({
        asked,
        conversationId: context.conversationId,
        kind: "question_asked",
        questionId: id,
        services,
      });
      await publishWaiting(services, context.conversationId, id, content.body);
      return {
        question: { id, title: content.title },
        next_step: ASKED_NEXT_STEP,
      };
    },
  });
}

/**
 * Report that the Conversation that asked waits on a person. The Event key
 * is the question, so it reports each question once.
 */
async function publishWaiting(
  services: ConversationChangeServices,
  conversationId: string,
  questionId: string,
  body: string,
): Promise<void> {
  await publishAgentUpdate(
    conversationId,
    { type: "waiting", id: questionId },
    {
      queue: services.queue(),
      update: async () => ({ status: "waiting", text: body }),
    },
  );
}
