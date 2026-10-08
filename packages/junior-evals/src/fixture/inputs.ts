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
  /** `im` starts a direct message Conversation. */
  channelType?: "channel" | "im";
  /** Files that the person uploaded with the message. */
  files?: FileInput[];
  /** The text of a message that the person forwarded with this one. */
  forwarded?: string;
  /** Another Slack app posted the message. Its bot user is the author. */
  fromApp?: boolean;
  text: string;
}

/** A thread message without a mention through the Slack Events API webhook. */
export interface ThreadMessageInput {
  kind: "thread_message";
  author?: SlackAuthor;
  /** Files that the person uploaded with the message. */
  files?: FileInput[];
  /** The text of a message that the person forwarded with this one. */
  forwarded?: string;
  text: string;
}

/** A slash command of Junior through the Slack webhook, with a valid signature. */
export interface SlackCommandInput {
  kind: "slack_command";
  author?: SlackAuthor;
  /** The text after the command name, such as `unlink github`. */
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
  /** `first` opens the oldest link that the person got, not the newest. */
  link?: "first";
  /** The plugin name, such as `github`. */
  provider: string;
}

/** A message from a person. History items use the same inputs. */
export type MessageInput = MentionInput | ThreadMessageInput | WebMessageInput;

/** An input that starts a Conversation from an automation. */
export type AutomationInput = HeartbeatInput | GitHubWebhookInput;

export type Input =
  | MessageInput
  | AutomationInput
  | CompleteAuthInput
  | SlackCommandInput;

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

/**
 * A message that another Slack app posted before the first input in loaded
 * history. It is in the Slack thread only.
 */
export interface AppMessage {
  kind: "app_message";
  text: string;
}

export type HistoryItem = MessageInput | HistoryReply | AppMessage;

/**
 * Mention Junior in Slack. `run()` posts it to a new thread. With `fromApp`,
 * another Slack app posted the mention, as an alert tool does.
 */
export function slackMention(
  text: string,
  options: {
    author?: SlackAuthor;
    channel?: MentionChannel;
    channelType?: "channel" | "im";
    files?: FileInput[];
    forwarded?: string;
    fromApp?: boolean;
  } = {},
): MentionInput {
  return { kind: "mention", text, ...options };
}

/** Post in the Slack thread without mentioning Junior. */
export function slackThreadMessage(
  text: string,
  options: {
    author?: SlackAuthor;
    files?: FileInput[];
    forwarded?: string;
  } = {},
): ThreadMessageInput {
  return { kind: "thread_message", text, ...options };
}

/**
 * Run the slash command of Junior in the Slack channel of the Conversation,
 * such as `slackCommand("unlink github")`. Junior answers the person in
 * private and starts no turn.
 */
export function slackCommand(
  text: string,
  options: { author?: SlackAuthor } = {},
): SlackCommandInput {
  return { kind: "slack_command", text, ...options };
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
 * gave the person, and it returns the resumed turn. The link is the connect
 * prompt of the dashboard when the dashboard shows one, or the newest link
 * that Junior sent to the person in private in Slack. With `author`, it is
 * the Slack link of that person. With `link: "first"`, it is the oldest Slack
 * link, which a person who asked two times can still open. It fails when
 * Junior gave the person no link.
 */
export function completeAuth(
  provider: string,
  options: { author?: SlackAuthor; link?: "first" } = {},
): CompleteAuthInput {
  return { kind: "complete_auth", provider, ...options };
}

/**
 * A message from another Slack app for `history`, such as an alert that
 * starts the thread. Junior took no turn for it and stored nothing, so a
 * later turn reads it from Slack. It comes before the first input.
 */
export function slackAppMessage(text: string): AppMessage {
  return { kind: "app_message", text };
}

/** An earlier Junior reply for `history`. Pass it to `fork()` to fork there. */
export function reply(
  text: string,
  options: { toolHistory?: HistoryReply["toolHistory"] } = {},
): HistoryReply {
  return { kind: "reply", text, ...options };
}
