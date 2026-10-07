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

/**
 * A file that a person uploaded with a message. Without `content`, the
 * download from Slack fails.
 */
export interface FileInput {
  content?: Buffer;
  mimeType: string;
  name: string;
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
  /** Files that the person uploaded with the message. */
  files?: FileInput[];
  text: string;
}

/** A thread message without a mention through the Slack Events API webhook. */
export interface ThreadMessageInput {
  kind: "thread_message";
  author?: SlackAuthor;
  /** Files that the person uploaded with the message. */
  files?: FileInput[];
  text: string;
}

/** A dashboard message through `POST /api/conversations`. */
export interface WebMessageInput {
  kind: "web_message";
  /** Images that the person added to the message. */
  images?: FileInput[];
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

/** The OAuth or MCP OAuth callback route, after the person approves. */
export interface CompleteAuthInput {
  kind: "complete_auth";
  author?: SlackAuthor;
  /** The plugin name, such as `github`. */
  provider: string;
}

/** A message from a person. History items use the same inputs. */
export type MessageInput = MentionInput | ThreadMessageInput | WebMessageInput;

/** An input that starts a Conversation from an automation. */
export type AutomationInput = HeartbeatInput | GitHubWebhookInput;

export type Input = MessageInput | AutomationInput | CompleteAuthInput;

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
    files?: FileInput[];
  } = {},
): MentionInput {
  return { kind: "mention", text, ...options };
}

/** Post in the Slack thread without mentioning Junior. */
export function threadMessage(
  text: string,
  options: { author?: SlackAuthor; files?: FileInput[] } = {},
): ThreadMessageInput {
  return { kind: "thread_message", text, ...options };
}

/** Send a message from the dashboard. */
export function webMessage(
  text: string,
  options: { images?: FileInput[] } = {},
): WebMessageInput {
  return { kind: "web_message", text, ...options };
}

/** A file for `files` or `images`. A string is the text of the file. */
export function file(
  name: string,
  mimeType: string,
  content: string | Buffer,
): FileInput {
  return { content: Buffer.from(content), mimeType, name };
}

/** A file for `files` that Slack cannot serve, so its download fails. */
export function unavailableFile(name: string, mimeType: string): FileInput {
  return { mimeType, name };
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

/**
 * Finish the authorization that a turn waits for.
 * `conversation.continue(completeAuth(provider))` opens the link that Junior
 * sent to the person in private, and it returns the resumed turn. It fails
 * when Junior sent the person no private link.
 */
export function completeAuth(
  provider: string,
  options: { author?: SlackAuthor } = {},
): CompleteAuthInput {
  return { kind: "complete_auth", provider, ...options };
}

/** An earlier Junior reply for `history`. Pass it to `fork()` to fork there. */
export function reply(
  text: string,
  options: { toolHistory?: HistoryReply["toolHistory"] } = {},
): HistoryReply {
  return { kind: "reply", text, ...options };
}
