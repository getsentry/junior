/**
 * Slack Block Kit types used by the render-intent layer and the outbound
 * boundary. This is a local subset of the Slack API surface — just the
 * fields the repository actually emits.
 */

export interface SlackMrkdwnText {
  text: string;
  type: "mrkdwn";
}

export interface SlackPlainText {
  emoji?: boolean;
  text: string;
  type: "plain_text";
}

export interface SlackHeaderBlock {
  text: SlackPlainText;
  type: "header";
}

export interface SlackSectionBlock {
  fields?: SlackMrkdwnText[];
  text?: SlackMrkdwnText;
  type: "section";
}

export interface SlackDividerBlock {
  type: "divider";
}

export interface SlackContextBlock {
  elements: SlackMrkdwnText[];
  type: "context";
}

export interface SlackLinkButtonElement {
  text: SlackPlainText;
  type: "button";
  url: string;
}

export interface SlackActionsBlock {
  elements: SlackLinkButtonElement[];
  type: "actions";
}

export type SlackMessageBlock =
  | SlackActionsBlock
  | SlackContextBlock
  | SlackDividerBlock
  | SlackHeaderBlock
  | SlackSectionBlock;

/** Escape user-provided text for safe inclusion in Slack mrkdwn fields. */
export function escapeSlackMrkdwnText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
