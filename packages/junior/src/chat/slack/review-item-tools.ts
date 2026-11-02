import type { ProviderTenant } from "@/api/conversations/access";
import { createSlackActor } from "@/chat/actor";
import { getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { ReviewItemToolServices } from "@/chat/tools/review-items";
import { readActorIdentityFromSql } from "@/chat/plugins/viewer";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { parseSlackUserId } from "./ids";
import { createSlackReviewItemShow } from "./review-item-card-sync";

const SLACK_MENTION = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/;

/**
 * Find the Junior User of a Slack mention, such as `<@U123>` or `U123`, in
 * one Slack workspace. Return undefined when the text is not a Slack user.
 * Throw a `ToolInputError` when the person has no Junior User in the
 * workspace of `tenant`, so an agent assigns them by email instead.
 */
async function findSlackMentionedUserId(
  text: string,
  tenant: ProviderTenant | undefined,
): Promise<string | undefined> {
  const slackUserId = parseSlackUserId(SLACK_MENTION.exec(text)?.[1] ?? text);
  if (!slackUserId) return undefined;
  const user =
    tenant?.provider === "slack"
      ? (
          await readActorIdentityFromSql(
            getDb(),
            createSlackActor(tenant.providerTenantId, slackUserId, undefined),
          )
        )?.user
      : undefined;
  if (!user) {
    throw new ToolInputError(
      `<@${slackUserId}> has no Junior user yet. Assign them by email.`,
    );
  }
  return user.id;
}

/**
 * The Slack services of the Review item tools: Slack mentions resolve to
 * Users, and Slack cards show each change. A Slack Turn has the token of its
 * workspace. Other runs use the default bot token.
 */
export function createSlackReviewItemToolServices(
  queue: () => ConversationWorkQueue,
): ReviewItemToolServices {
  return {
    findMentionedUserId: findSlackMentionedUserId,
    queue,
    show: createSlackReviewItemShow(),
  };
}
