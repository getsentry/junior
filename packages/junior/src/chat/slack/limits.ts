// Slack's documented block limits for one message. Slack rejects the whole
// message with `invalid_blocks` when its blocks break one, so renderers keep
// their blocks inside them, and the Slack test fake rejects blocks over them.
// https://docs.slack.dev/reference/block-kit/blocks
// https://docs.slack.dev/reference/block-kit/blocks/markdown-block

/** Blocks in one message. */
export const SLACK_MAX_MESSAGE_BLOCKS = 50;

/** Characters in all `markdown` blocks of one message together. */
export const SLACK_MAX_MARKDOWN_CHARS = 12_000;

/** Characters in one text object, such as section text or a context element. */
export const SLACK_MAX_TEXT_OBJECT_CHARS = 3_000;
