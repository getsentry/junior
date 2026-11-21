import type { InboxItemToolServices } from "@/chat/inbox-items/tool-support";
import type { ProviderTenant } from "@/api/conversations/access";
import { createSlackActor } from "@/chat/actor";
import { getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { readActorIdentityFromSql } from "@/chat/plugins/viewer";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { parseSlackUserId } from "./ids";
import { createSlackInboxItemShow } from "./inbox-item-card-sync";

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
      `<@${slackUserId}> has no User yet. Assign them by email.`,
    );
  }
  return user.id;
}

/**
 * The Slack services of the Inbox item tools: Slack mentions resolve to
 * Users, and Slack cards show each change. A Slack Turn has the token of its
 * workspace. Other runs use the default bot token.
 */
export function createSlackInboxItemToolServices(
  queue: () => ConversationWorkQueue,
): InboxItemToolServices {
  return {
    findMentionedUserId: findSlackMentionedUserId,
    queue,
    show: createSlackInboxItemShow(),
  };
}
