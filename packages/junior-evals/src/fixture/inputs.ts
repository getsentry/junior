/**
 * Inputs say what reached Junior. The fixture sends each one through the app
 * route that production uses. History items use the same builders.
 */
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

/** A Slack person. The Slack mock answers `users.info` with these fields. */
export interface SlackAuthor {
  fullName?: string;
  userId?: string;
  userName?: string;
}

/** A Slack channel from `slackChannel()`. */
export interface MentionChannel {
  channelId: string;
}

/** An `app_mention` through the Slack Events API webhook. */
export interface MentionInput {
  kind: "mention";
  author?: SlackAuthor;
  /** The channel for a new thread. Defaults to a new channel. */
  channel?: MentionChannel;
  /** `im` starts a direct message Conversation. */
  channelType?: "channel" | "im";
  text: string;
}

/** A thread message without a mention through the Slack Events API webhook. */
export interface ThreadMessageInput {
  kind: "thread_message";
  author?: SlackAuthor;
  text: string;
}

/** A dashboard message through `POST /api/conversations`. */
export interface WebMessageInput {
  kind: "web_message";
  text: string;
}

/** The authenticated heartbeat route, which runs due automations. */
export interface HeartbeatInput {
  kind: "heartbeat";
}

/** A message from a person. History items use the same inputs. */
export type MessageInput = MentionInput | ThreadMessageInput | WebMessageInput;

export type Input = MessageInput | HeartbeatInput;

/** An earlier Junior reply in loaded history. */
export interface HistoryReply {
  kind: "reply";
  text: string;
  /** Completed tool work before this reply. People did not see it. */
  toolHistory?: Array<AssistantMessage | ToolResultMessage>;
}

export type HistoryItem = MessageInput | HistoryReply;

/** Mention Junior in Slack. `run()` posts it to a new thread. */
export function mention(
  text: string,
  options: {
    author?: SlackAuthor;
    channel?: MentionChannel;
    channelType?: "channel" | "im";
  } = {},
): MentionInput {
  return { kind: "mention", text, ...options };
}

/** Post in the Slack thread without mentioning Junior. */
export function threadMessage(
  text: string,
  options: { author?: SlackAuthor } = {},
): ThreadMessageInput {
  return { kind: "thread_message", text, ...options };
}

/** Send a message from the dashboard. */
export function webMessage(text: string): WebMessageInput {
  return { kind: "web_message", text };
}

/**
 * Call the heartbeat route. `run(heartbeat())` returns the Conversation that
 * the due automation started.
 */
export function heartbeat(): HeartbeatInput {
  return { kind: "heartbeat" };
}

/** An earlier Junior reply for `history`. Pass it to `fork()` to fork there. */
export function reply(
  text: string,
  options: { toolHistory?: HistoryReply["toolHistory"] } = {},
): HistoryReply {
  return { kind: "reply", text, ...options };
}
