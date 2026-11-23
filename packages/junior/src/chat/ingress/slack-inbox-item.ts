import type { SlackAdapter } from "@chat-adapter/slack";
import type { User } from "@sentry/junior-plugin-api";
import type { Message, StateAdapter } from "chat";
import { logException } from "@/chat/logging";
import {
  canActOnInboxItem,
  isPluginInboxItem,
} from "@/chat/inbox-items/access";
import {
  actOnInboxItem,
  readInboxItemForUser,
  InboxItemActionError,
  reviewItemChange,
  type InboxItemAction,
} from "@/chat/inbox-items/actions";
import {
  deliverInboxItemChange,
  type InboxItemDelivery,
} from "@/chat/inbox-items/changes";
import {
  renderInboxItemMessage,
  inboxItemChangeRecord,
} from "@/chat/inbox-items/messages";
import type { InboxItem } from "@/chat/inbox-items/store";
import { parseSlackChannelId } from "@/chat/slack/ids";
import {
  openSlackModal,
  postSlackEphemeralMessage,
} from "@/chat/slack/outbound";
import {
  buildSlackInboxItemModal,
  parseSlackInboxItemFormTarget,
  type SlackInboxItemClick,
} from "@/chat/slack/inbox-item-card";
import { createInboxItemShow } from "@/chat/notifications/inbox-item-show";
import {
  resolveSlackInboxItemCardConversationId,
  syncInboxItemSlackCards,
} from "@/chat/slack/inbox-item-card-sync";
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
} from "@/chat/inbox-items/user-input-request";
import { resolveSlackActingUser } from "./slack-acting-user";
import {
  buildSlackInteractionInput,
  type SlackInteractionInputFacts,
} from "./slack-interaction-input";
import type { SlackInteractivePayload } from "./slack-payload";

/** What an Inbox item interaction handler needs from Slack ingress. */
export interface SlackInboxItemServices {
  adapter: SlackAdapter;
  isAuthorAllowed: (userId: string) => Promise<boolean>;
  persistMessage: (
    message: Message,
    facts?: SlackInteractionInputFacts,
  ) => Promise<void>;
  queue: ConversationWorkQueue;
  state: StateAdapter;
}

interface CardTarget {
  channelId: string;
  messageTs: SlackMessageTs;
  threadTs: SlackMessageTs;
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

function resolveActingUser(
  services: SlackInboxItemServices,
  payload: SlackInteractivePayload,
  target: CardTarget,
) {
  return resolveSlackActingUser({
    isAuthorAllowed: services.isAuthorAllowed,
    payload,
    state: services.state,
    tell: (userId, text) => tellPerson(target, userId, text),
  });
}

/** Show the current state of an item, such as after a click on a stale card. */
async function refreshCards(
  services: SlackInboxItemServices,
  user: User,
  itemId: string,
): Promise<void> {
  const item = await readInboxItemForUser(user, itemId).catch(() => undefined);
  if (!item) return;
  await syncInboxItemSlackCards({
    getSlackAdapter: () => services.adapter,
    itemId: item.id,
  });
}

/**
 * Do one person action from a Slack card. The thread of the card gets an
 * answer as Slack input from the person, like a typed reply. A dismiss, or
 * the answer to a plugin item, starts no Turn, so the thread gets the same
 * recorded Message as the other linked Conversations, from
 * `actOnInboxItem`. An expected failure, such as
 * an item that is already closed, goes to the person as an ephemeral
 * message.
 */
async function act(args: {
  action: InboxItemAction;
  answer?: (item: InboxItem) => UserInputAnswer;
  inputTs: SlackMessageTs;
  itemId: string;
  messageId: string;
  payload: SlackInteractivePayload;
  services: SlackInboxItemServices;
  target: CardTarget;
}): Promise<void> {
  const { services, target } = args;
  const actor = await resolveActingUser(services, args.payload, target);
  if (!actor) return;
  const conversationId = await resolveSlackInboxItemCardConversationId({
    channelId: target.channelId,
    teamId: actor.teamId,
    threadTs: target.threadTs,
  });
  const delivery: InboxItemDelivery = {
    queue: services.queue,
    show: createInboxItemShow(() => services.adapter),
  };
  let recordOnly = args.action === "dismiss";
  let item: InboxItem;
  try {
    const current = await readInboxItemForUser(actor.user, args.itemId);
    // The plugin that added an item does the work of its answer, so the
    // thread gets the recorded Message, not input that starts a Turn.
    const pluginAnswer = args.action === "submit" && isPluginInboxItem(current);
    recordOnly ||= pluginAnswer;
    item = await actOnInboxItem({
      action: args.action,
      ...(recordOnly ? undefined : { exceptConversationId: conversationId }),
      // Two clicks can both see an open item. Only the click that closes it
      // adds the input to this thread, so one action adds one Turn. A plugin
      // answer adds no input, so a retry of it after a failed plugin hook
      // calls the plugin again.
      firstCloseOnly: !pluginAnswer,
      delivery,
      id: current.id,
      user: actor.user,
      ...(args.answer ? { answer: args.answer(current) } : undefined),
    });
  } catch (error) {
    if (!(error instanceof InboxItemActionError)) throw error;
    await tellPerson(target, actor.slackUserId, error.message);
    await refreshCards(services, actor.user, args.itemId);
    return;
  }
  if (recordOnly || !item.conversationIds.includes(conversationId)) return;
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
        text: renderInboxItemMessage(item, change),
        threadTs: target.threadTs,
        userId: actor.slackUserId,
      }),
      { reviewItemChange: inboxItemChangeRecord(item, change) },
    );
  } catch (error) {
    // The item is already closed, so the thread must still learn about it.
    // Each message has an idempotency key, so only this thread gets one.
    logException(error, "inbox_item.slack_input.persist.failed", {
      "app.inbox_item.id": item.id,
    });
    await deliverInboxItemChange({
      change,
      delivery,
      item,
      nowMs: Date.now(),
    });
  }
}

function cardTarget(payload: SlackInteractivePayload): CardTarget {
  const channelId = parseSlackChannelId(payload.channel?.id);
  const messageTs = parseSlackMessageTs(payload.message?.ts);
  if (!channelId || !messageTs) {
    throw new Error("Slack inbox item payload is incomplete");
  }
  const threadTs = parseSlackMessageTs(payload.message?.thread_ts) ?? messageTs;
  return { channelId, messageTs, threadTs };
}

async function openAnswerForm(args: {
  itemId: string;
  payload: SlackInteractivePayload;
  services: SlackInboxItemServices;
  target: CardTarget;
}): Promise<void> {
  const { target } = args;
  const triggerId = args.payload.trigger_id;
  if (!triggerId) {
    throw new Error("Slack inbox item form payload is missing a trigger id");
  }
  const actor = await resolveActingUser(args.services, args.payload, target);
  if (!actor) return;
  let item: InboxItem;
  try {
    item = await readInboxItemForUser(actor.user, args.itemId);
  } catch (error) {
    if (!(error instanceof InboxItemActionError)) throw error;
    await tellPerson(target, actor.slackUserId, error.message);
    return;
  }
  if (!canActOnInboxItem(item, actor.user.id)) {
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
  const view = buildSlackInboxItemModal(item, {
    ...target,
    itemId: item.id,
  });
  if (!view) return;
  await openSlackModal({ triggerId, view });
}

/** Handle one click on an Inbox item card. */
export async function handleSlackInboxItemClick(args: {
  action: NonNullable<SlackInteractivePayload["actions"]>[number];
  click: SlackInboxItemClick;
  payload: SlackInteractivePayload;
  services: SlackInboxItemServices;
}): Promise<void> {
  const { click, payload, services } = args;
  const target = cardTarget(payload);
  if (click.kind === "answer") {
    await openAnswerForm({ itemId: click.itemId, payload, services, target });
    return;
  }
  const actionTs = parseSlackMessageTs(args.action.action_ts);
  if (!actionTs) {
    throw new Error("Slack inbox item click payload is incomplete");
  }
  const common = {
    inputTs: actionTs,
    itemId: click.itemId,
    messageId: `slack-inbox-item:${actionTs}`,
    payload,
    services,
    target,
  };
  if (click.kind === "dismiss") {
    await act({ ...common, action: "dismiss" });
    return;
  }
  await act({
    ...common,
    action: "submit",
    // A card can be stale. Accept the clicked label only while the item
    // still offers it.
    answer: (item) => {
      const field = item.request && buttonUserInputField(item.request);
      if (!field?.options.some((option) => option.label === click.label)) {
        throw new InboxItemActionError(
          "conflict",
          "This card changed. Use the updated card.",
        );
      }
      return { requestId: item.id, values: { [field.id]: [click.label] } };
    },
  });
}

/** Submit the answer of an Inbox item form. */
export async function handleSlackInboxItemSubmission(args: {
  payload: SlackInteractivePayload;
  services: SlackInboxItemServices;
}): Promise<void> {
  const view = args.payload.view;
  const formTarget = parseSlackInboxItemFormTarget(view?.private_metadata);
  const channelId = parseSlackChannelId(formTarget?.channelId);
  const messageTs = parseSlackMessageTs(formTarget?.messageTs);
  const threadTs = parseSlackMessageTs(formTarget?.threadTs);
  if (!view?.id || !formTarget || !channelId || !messageTs || !threadTs) {
    throw new Error("Slack inbox item form submission is incomplete");
  }
  await act({
    action: "submit",
    // `actOnInboxItem` rejects an answer to an item without a request.
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
    messageId: `slack-inbox-item:${view.id}`,
    payload: args.payload,
    services: args.services,
    target: { channelId, messageTs, threadTs },
  });
}
