import type { SlackAdapter } from "@chat-adapter/slack";
import type { User } from "@sentry/junior-plugin-api";
import type { Message, StateAdapter } from "chat";
import { createSlackActor, parseActorUserId } from "@/chat/actor";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { logException } from "@/chat/logging";
import { readActorIdentity } from "@/chat/plugins/viewer";
import {
  actOnReviewItem,
  canActOnReviewItem,
  readReviewItemForUser,
  ReviewItemActionError,
  reviewItemChange,
  type ReviewItemAction,
} from "@/chat/review-items/actions";
import {
  renderReviewItemMessage,
  sendReviewItemMessages,
} from "@/chat/review-items/messages";
import type { ReviewItem } from "@/chat/review-items/store";
import { parseSlackChannelId } from "@/chat/slack/ids";
import {
  openSlackModal,
  postSlackEphemeralMessage,
} from "@/chat/slack/outbound";
import {
  buildSlackReviewItemModal,
  parseSlackReviewItemFormTarget,
  type SlackReviewItemClick,
} from "@/chat/slack/review-item-card";
import { syncReviewItemSlackCards } from "@/chat/slack/review-item-card-sync";
import {
  parseSlackMessageTs,
  slackMessageTsFromMs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import { parseSlackUserInputSubmission } from "@/chat/slack/user-input";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  buttonUserInputField,
  type UserInputAnswer,
} from "@/chat/tools/runtime/user-input-request";
import { buildSlackInteractionInput } from "./slack-interaction-input";
import type { SlackInteractivePayload } from "./slack-payload";

/** What a Review item interaction handler needs from Slack ingress. */
export interface SlackReviewItemServices {
  adapter: SlackAdapter;
  isAuthorAllowed: (userId: string) => Promise<boolean>;
  persistMessage: (message: Message) => Promise<void>;
  queue: ConversationWorkQueue;
  state: StateAdapter;
}

interface CardTarget {
  channelId: string;
  messageTs: SlackMessageTs;
  threadTs: SlackMessageTs;
}

function conversationIdOf(target: CardTarget): string {
  return `slack:${target.channelId}:${target.threadTs}`;
}

async function tellPerson(
  target: CardTarget,
  userId: string,
  text: string,
): Promise<void> {
  await postSlackEphemeralMessage({
    channelId: target.channelId,
    text,
    threadTs: target.threadTs,
    userId,
  });
}

/**
 * Resolve the Junior User of the person who acted. An action starts a Turn
 * as that person, so it needs the same workspace and allowed domain checks
 * as a Slack mention.
 */
async function resolveActingUser(
  services: SlackReviewItemServices,
  payload: SlackInteractivePayload,
  target: CardTarget,
): Promise<{ slackUserId: string; user: User } | undefined> {
  const slackUserId = parseActorUserId(payload.user?.id);
  const teamId = payload.team?.id ?? payload.user?.team_id;
  if (!slackUserId || !teamId) {
    throw new Error("Slack review item payload is missing a user or team");
  }
  if (
    !(await isSlackWorkspaceMember(
      { user: slackUserId, user_team: payload.user?.team_id },
      services.state,
    )) ||
    !(await services.isAuthorAllowed(slackUserId))
  ) {
    return undefined;
  }
  const user = (
    await readActorIdentity(createSlackActor(teamId, slackUserId, undefined))
  )?.user;
  if (!user) {
    await tellPerson(
      target,
      slackUserId,
      "Junior does not know your account yet. Sign in to the Junior dashboard, then try again.",
    );
    return undefined;
  }
  return { slackUserId, user };
}

/** Show the current state of an item, such as after a click on a stale card. */
async function refreshCards(
  services: SlackReviewItemServices,
  user: User,
  itemId: string,
): Promise<void> {
  const item = await readReviewItemForUser(user, itemId).catch(() => undefined);
  if (!item) return;
  await syncReviewItemSlackCards({
    getSlackAdapter: () => services.adapter,
    item,
  });
}

/**
 * Do one person action from a Slack card. The thread of the card gets the
 * action as Slack input from the person, like an answer to
 * `requestUserInput`. The other linked Conversations get messages from
 * `actOnReviewItem`. An expected failure, such as an item that is already
 * closed, goes to the person as an ephemeral message.
 */
async function act(args: {
  action: ReviewItemAction;
  answer?: (item: ReviewItem) => UserInputAnswer;
  inputTs: SlackMessageTs;
  itemId: string;
  messageId: string;
  payload: SlackInteractivePayload;
  services: SlackReviewItemServices;
  target: CardTarget;
}): Promise<void> {
  const { services, target } = args;
  const actor = await resolveActingUser(services, args.payload, target);
  if (!actor) return;
  const conversationId = conversationIdOf(target);
  let item: ReviewItem;
  try {
    const current = await readReviewItemForUser(actor.user, args.itemId);
    item = await actOnReviewItem({
      action: args.action,
      exceptConversationId: conversationId,
      // Two clicks can both see an open item. Only the click that closes it
      // adds the input to this thread, so one action adds one Turn.
      firstCloseOnly: true,
      getSlackAdapter: () => services.adapter,
      id: current.id,
      queue: services.queue,
      user: actor.user,
      ...(args.answer ? { answer: args.answer(current) } : undefined),
    });
  } catch (error) {
    if (!(error instanceof ReviewItemActionError)) throw error;
    await tellPerson(target, actor.slackUserId, error.message);
    await refreshCards(services, actor.user, args.itemId);
    return;
  }
  if (!item.conversationIds.includes(conversationId)) return;
  const change = reviewItemChange(args.action, actor.user);
  try {
    await services.persistMessage(
      buildSlackInteractionInput({
        adapter: services.adapter,
        channelId: target.channelId,
        inputTs: args.inputTs,
        messageId: args.messageId,
        messageTs: target.messageTs,
        payload: args.payload,
        text: renderReviewItemMessage(item, change),
        threadTs: target.threadTs,
        userId: actor.slackUserId,
      }),
    );
  } catch (error) {
    // The item is already closed, so the thread must still learn about it.
    // Each message has an idempotency key, so only this thread gets one.
    logException(error, "review_item.slack_input.persist.failed", {
      "app.review_item.id": item.id,
    });
    await sendReviewItemMessages({
      change,
      item,
      nowMs: Date.now(),
      queue: services.queue,
    });
  }
}

function cardTarget(payload: SlackInteractivePayload): CardTarget {
  const channelId = parseSlackChannelId(payload.channel?.id);
  const messageTs = parseSlackMessageTs(payload.message?.ts);
  if (!channelId || !messageTs) {
    throw new Error("Slack review item payload is incomplete");
  }
  const threadTs = parseSlackMessageTs(payload.message?.thread_ts) ?? messageTs;
  return { channelId, messageTs, threadTs };
}

async function openAnswerForm(args: {
  itemId: string;
  payload: SlackInteractivePayload;
  services: SlackReviewItemServices;
  target: CardTarget;
}): Promise<void> {
  const { target } = args;
  const triggerId = args.payload.trigger_id;
  if (!triggerId) {
    throw new Error("Slack review item form payload is missing a trigger id");
  }
  const actor = await resolveActingUser(args.services, args.payload, target);
  if (!actor) return;
  let item: ReviewItem;
  try {
    item = await readReviewItemForUser(actor.user, args.itemId);
  } catch (error) {
    if (!(error instanceof ReviewItemActionError)) throw error;
    await tellPerson(target, actor.slackUserId, error.message);
    return;
  }
  if (!canActOnReviewItem(item, actor.user.id)) {
    await tellPerson(
      target,
      actor.slackUserId,
      item.status === "open"
        ? "Only an assignee can act on this item."
        : "This item is already closed.",
    );
    await refreshCards(args.services, actor.user, item.id);
    return;
  }
  const view = buildSlackReviewItemModal(item, {
    ...target,
    itemId: item.id,
  });
  if (!view) return;
  await openSlackModal({ triggerId, view });
}

/** Handle one click on a Review item card. */
export async function handleSlackReviewItemClick(args: {
  action: NonNullable<SlackInteractivePayload["actions"]>[number];
  click: SlackReviewItemClick;
  payload: SlackInteractivePayload;
  services: SlackReviewItemServices;
}): Promise<void> {
  const { click, payload, services } = args;
  const target = cardTarget(payload);
  if (click.kind === "answer") {
    await openAnswerForm({ itemId: click.itemId, payload, services, target });
    return;
  }
  const actionTs = parseSlackMessageTs(args.action.action_ts);
  if (!actionTs) {
    throw new Error("Slack review item click payload is incomplete");
  }
  const common = {
    inputTs: actionTs,
    itemId: click.itemId,
    messageId: `slack-review-item:${actionTs}`,
    payload,
    services,
    target,
  };
  if (click.kind === "done") {
    await act({ ...common, action: "complete" });
    return;
  }
  if (click.kind === "dismiss") {
    await act({ ...common, action: "dismiss" });
    return;
  }
  await act({
    ...common,
    action: "submit",
    // The item, not the click, owns the option label.
    answer: (item) => {
      const field = item.request && buttonUserInputField(item.request);
      const label = field?.options[click.index]?.label;
      return {
        requestId: item.id,
        values: field && label ? { [field.id]: [label] } : {},
      };
    },
  });
}

/** Submit the answer of a Review item form. */
export async function handleSlackReviewItemSubmission(args: {
  payload: SlackInteractivePayload;
  services: SlackReviewItemServices;
}): Promise<void> {
  const view = args.payload.view;
  const formTarget = parseSlackReviewItemFormTarget(view?.private_metadata);
  const channelId = parseSlackChannelId(formTarget?.channelId);
  const messageTs = parseSlackMessageTs(formTarget?.messageTs);
  const threadTs = parseSlackMessageTs(formTarget?.threadTs);
  if (!view?.id || !formTarget || !channelId || !messageTs || !threadTs) {
    throw new Error("Slack review item form submission is incomplete");
  }
  await act({
    action: "submit",
    // `actOnReviewItem` rejects an answer to an item without a request.
    answer: (item) =>
      item.request
        ? parseSlackUserInputSubmission({
            request: item.request,
            requestId: item.id,
            values: view.state?.values ?? {},
          })
        : { requestId: item.id, values: {} },
    inputTs: slackMessageTsFromMs(Date.now()),
    itemId: formTarget.itemId,
    messageId: `slack-review-item:${view.id}`,
    payload: args.payload,
    services: args.services,
    target: { channelId, messageTs, threadTs },
  });
}
