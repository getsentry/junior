import { getStateAdapter } from "@/chat/state/adapter";
import {
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
  type ConversationWorkQueueTestAdapter,
} from "./conversation-work";

/** Build a Slack channel-message Event trigger for an Automation. */
export function channelMessageTrigger(
  match?: Record<string, string | string[]>,
) {
  return {
    type: "event" as const,
    namespace: "slack",
    label: "New messages in #discuss-integration",
    events: ["message.posted"],
    ...(match ? { match } : undefined),
  };
}

/** Post one Slack channel message through the real webhook ingress. */
export async function postChannelMessage(
  queue: ConversationWorkQueueTestAdapter,
  input: {
    attachments?: unknown[];
    blocks?: unknown[];
    botId?: string;
    botProfile?: Record<string, unknown>;
    channel?: string;
    envelope?: Record<string, unknown>;
    files?: Array<Record<string, unknown>>;
    /** Post as an app integration: a `bot_message` with a `bot_id` and no `user`. */
    noUser?: boolean;
    text?: string;
    threadTs?: string;
    ts: string;
    user?: string;
  },
) {
  const state = getStateAdapter();
  await state.connect();
  const slackAdapter = createSlackAdapterFixture();
  const {
    attachments,
    blocks,
    botId,
    botProfile,
    envelope: fields,
    files,
    noUser,
    ...message
  } = input;
  const envelope = slackEnvelope({
    eventType: "message",
    text: "How do I connect the Jira integration?",
    ...message,
  });
  if (botId) Object.assign(envelope.event, { bot_id: botId });
  if (blocks) Object.assign(envelope.event, { blocks });
  if (botProfile) Object.assign(envelope.event, { bot_profile: botProfile });
  if (files) Object.assign(envelope.event, { files });
  if (attachments) Object.assign(envelope.event, { attachments });
  if (noUser) {
    Reflect.deleteProperty(envelope.event, "user");
    Object.assign(envelope.event, { subtype: "bot_message" });
  }
  if (fields) Object.assign(envelope, fields);
  return await handleSlackWebhookAndFlush({
    request: slackWebhookRequest(envelope),
    services: {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    },
  });
}
