/**
 * Inputs say what reached Junior. The fixture sends each one through the app
 * route that production uses. History items use the same builders.
 */

/** A Slack person. The Slack mock answers `users.info` with these fields. */
export interface SlackAuthor {
  fullName?: string;
  userId?: string;
  userName?: string;
}

/** A Slack person for `author`, such as `person("U0SAM", "Sam")`. */
export function person(userId: string, name: string): Required<SlackAuthor> {
  return {
    fullName: `${name} Example`,
    userId,
    userName: name.toLowerCase(),
  };
}

/** A Slack channel from `slackChannel()`. */
export interface MentionChannel {
  channelId: string;
}

/** Channel fields that any channel member can edit in Slack. */
export interface SlackChannelInfo {
  topic?: string;
  /** Slack shows this field as the channel description. */
  purpose?: string;
}

/** An `app_mention` through the Slack Events API webhook. */
export interface MentionInput {
  kind: "mention";
  author?: SlackAuthor;
  /** The channel for a new thread. Defaults to a new channel. */
  channel?: MentionChannel;
  /** The topic and description of a new channel. */
  channelInfo?: SlackChannelInfo;
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

/**
 * A GitHub webhook delivery through the GitHub plugin route, with a valid
 * signature. The fixture adds the configured installation.
 */
export interface GitHubWebhookInput {
  kind: "github_webhook";
  /** The `x-github-event` header, such as `pull_request_review`. */
  event: string;
  payload: Record<string, unknown>;
}

/** A message from a person. History items use the same inputs. */
export type MessageInput = MentionInput | ThreadMessageInput | WebMessageInput;

/** An input that starts a Conversation from an automation. */
export type AutomationInput = HeartbeatInput | GitHubWebhookInput;

export type Input = MessageInput | AutomationInput;

/** A completed tool call in loaded history. */
export interface HistoryToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** The tool output that the model saw. */
  result: unknown;
}

/** An earlier Junior reply in loaded history. */
export interface HistoryReply {
  kind: "reply";
  text: string;
  /** Completed tool calls before this reply. People did not see them. */
  toolHistory?: HistoryToolCall[];
}

export type HistoryItem = MessageInput | HistoryReply;

/** Mention Junior in Slack. `run()` posts it to a new thread. */
export function mention(
  text: string,
  options: {
    author?: SlackAuthor;
    channel?: MentionChannel;
    channelInfo?: SlackChannelInfo;
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

/**
 * Deliver a GitHub webhook. The agent needs the GitHub plugin.
 * `run(githubWebhook(...))` returns the Conversation that the matching event
 * automation started. `conversation.continue(githubWebhook(...))` returns
 * what the matching watches of that Conversation did.
 */
export function githubWebhook(
  event: string,
  payload: Record<string, unknown>,
): GitHubWebhookInput {
  return { kind: "github_webhook", event, payload };
}

/** An earlier Junior reply for `history`. Pass it to `fork()` to fork there. */
export function reply(
  text: string,
  options: { toolHistory?: HistoryReply["toolHistory"] } = {},
): HistoryReply {
  return { kind: "reply", text, ...options };
}
