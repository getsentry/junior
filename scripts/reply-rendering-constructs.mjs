/**
 * How each surface renders each construct that reply content can hold: a
 * Markdown feature, a Slack token agents write, or structured Message content,
 * not surface chrome. `check-reply-rendering.mjs` reads it. `fallback` keeps
 * the content in a simpler form; `unsupported` loses it. `note` says what the
 * reader sees or why. MCP and ACP send Markdown source, so GFM is native there.
 */

/**
 * @typedef {"slack" | "dashboard" | "ios" | "mcp" | "acp"} Surface
 * @typedef {"native" | "fallback" | "unsupported"} How
 * @typedef {{ how: How, file: string, marker: string, note?: string,
 *   handles?: string[] }} Support
 * @typedef {{ id: string, support: Record<Surface, Support> }} Construct
 */

/** Surfaces that show replies, with the code that renders them. */
export const SURFACES = {
  slack:
    "Slack `markdown` blocks and Block Kit (packages/junior/src/chat/slack/)",
  dashboard: "Dashboard transcript (packages/junior-dashboard/src/client/)",
  ios: "iOS app, through the public MCP server (apps/ios/)",
  mcp: "MCP clients (packages/junior/src/api/mcp/)",
  acp: "ACP clients (packages/junior/src/api/acp/)",
};

const SLACK = "packages/junior/src/chat/slack";
const DASHBOARD = "packages/junior-dashboard/src/client";
const IOS_KIT = "apps/ios/Packages/JuniorKit/Sources/JuniorKit/Markdown";
const IOS_APP = "apps/ios/Junior";

const SLACK_BLOCK = {
  file: `${SLACK}/footer.ts`,
  marker: '[{ type: "markdown", text }]',
};
const SLACK_MRKDWN = `${SLACK}/mrkdwn.ts`;
const DASHBOARD_MARKDOWN = `${DASHBOARD}/display-text/markdown.tsx`;
const DASHBOARD_MESSAGE = `${DASHBOARD}/conversations/TranscriptMessageView.tsx`;
const DASHBOARD_MENTIONS = `${DASHBOARD}/display-text/mentions.tsx`;
const IOS_BLOCKS = `${IOS_KIT}/MarkdownBlocks.swift`;
const IOS_INLINE = `${IOS_APP}/Components/InlineMarkdown.swift`;
const IOS_SLACK_LINKS = {
  file: `${IOS_KIT}/MarkdownInline.swift`,
  marker: "func normalizeSlackLinks",
};
const IOS_MESSAGE = {
  file: `${IOS_APP}/Conversation/TranscriptRows.swift`,
  marker: "struct MessageRow",
};
const MCP_TEXT = {
  file: "packages/junior/src/api/mcp/conversation.ts",
  marker: 'const text = data.text ?? "";',
};
const MCP_MESSAGES = {
  file: "packages/junior/src/api/mcp/conversation.ts",
  marker: "export function mcpMessages(",
};
const ACP_TEXT = {
  file: "packages/junior/src/api/acp/transport.ts",
  marker: 'content: { type: "text", text: message.text }',
};

/** @returns {Support} */
function native(ref, handles) {
  return { how: "native", ...ref, ...(handles ? { handles } : undefined) };
}

/** @returns {Support} */
function fallback(note, ref, handles) {
  return {
    how: "fallback",
    note,
    ...ref,
    ...(handles ? { handles } : undefined),
  };
}

/** @returns {Support} */
function unsupported(note, ref) {
  return { how: "unsupported", note, ...ref };
}

const at = (file, marker) => ({ file, marker });

/** A Markdown feature that MCP and ACP pass through as source. */
function markdown(id, support) {
  return {
    id,
    support: { ...support, mcp: native(MCP_TEXT), acp: native(ACP_TEXT) },
  };
}

const RAW_MENTION =
  "shows the raw Slack markup, and the client cannot resolve the Slack id";

/** @type {Construct[]} */
export const CONSTRUCTS = [
  markdown("paragraph", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "function Paragraph("), ["p"]),
    ios: native(at(IOS_BLOCKS, "case paragraph"), ["paragraph"]),
  }),
  markdown("heading", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "const HEADING_CLASS"), [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
    ]),
    ios: native(at(IOS_BLOCKS, "case heading"), ["heading"]),
  }),
  markdown("emphasis", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "em: ({ children })"), ["em"]),
    ios: native(at(IOS_INLINE, "intent.contains(.emphasized)")),
  }),
  markdown("strong", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "strong: ({ children })"), [
      "strong",
    ]),
    ios: native(at(IOS_INLINE, "intent.contains(.stronglyEmphasized)")),
  }),
  markdown("strikethrough", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "del: ({ children })"), ["del"]),
    ios: native(at(IOS_INLINE, "intent.contains(.strikethrough)")),
  }),
  markdown("inline-code", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "code: ({ children })"), ["code"]),
    ios: native(at(IOS_INLINE, "intent.contains(.code)")),
  }),
  markdown("code-block", {
    slack: native(at(`${SLACK}/output.ts`, "function getFenceContinuation")),
    dashboard: native(at(DASHBOARD_MARKDOWN, "pre: ({ children })"), ["pre"]),
    ios: native(at(IOS_BLOCKS, "case code("), ["code"]),
  }),
  markdown("link", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "function TranscriptAnchor("), [
      "a",
    ]),
    ios: native(at(IOS_INLINE, "run.link != nil")),
  }),
  markdown("bare-url", {
    slack: native(at(SLACK_MRKDWN, "function wrapBareReferences(")),
    dashboard: native(at(DASHBOARD_MARKDOWN, "function remarkBareUrlStops(")),
    ios: fallback(
      "the URL as text; the app does not link bare URLs itself",
      at(IOS_INLINE, "run.link != nil"),
    ),
  }),
  markdown("image", {
    slack: fallback(
      "a link to the image, with the alt text as its label",
      SLACK_BLOCK,
    ),
    dashboard: fallback(
      "a link to the image, with the alt text as its label",
      at(DASHBOARD_MARKDOWN, "Do not load remote images from transcript text"),
      ["img"],
    ),
    ios: unsupported(
      "Foundation's inline parser keeps only the alt text, and the app never reads its `imageURL`, so the image URL is lost",
      at(`${IOS_KIT}/MarkdownInline.swift`, "inlineOnlyPreservingWhitespace"),
    ),
  }),
  markdown("blockquote", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "blockquote: ({ children })"), [
      "blockquote",
    ]),
    ios: native(at(IOS_BLOCKS, "case quote("), ["quote"]),
  }),
  markdown("list", {
    slack: native(at(SLACK_MRKDWN, "function bulletListFollowUpParagraphs(")),
    dashboard: native(at(DASHBOARD_MARKDOWN, "ul: ({ children })"), [
      "ul",
      "ol",
      "li",
    ]),
    ios: native(at(IOS_BLOCKS, "case list("), ["list"]),
  }),
  markdown("task-list", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "task-list-item")),
    ios: native(
      at(`${IOS_APP}/Conversation/MarkdownView.swift`, "checkmark.square.fill"),
    ),
  }),
  markdown("table", {
    slack: native(at(`${SLACK}/output.ts`, "function splitOutsideTable(")),
    dashboard: native(at(DASHBOARD_MARKDOWN, "table: ({ children })"), [
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ]),
    ios: native(at(IOS_BLOCKS, "case table("), ["table"]),
  }),
  markdown("thematic-break", {
    slack: native(SLACK_BLOCK),
    dashboard: native(at(DASHBOARD_MARKDOWN, "hr: () =>"), ["hr"]),
    ios: native(at(IOS_BLOCKS, "case rule"), ["rule"]),
  }),
  {
    id: "slack-link",
    support: {
      slack: native(at(SLACK_MRKDWN, "function readExistingSlackAngleToken(")),
      dashboard: native(
        at(
          `${DASHBOARD}/display-text/links.ts`,
          "export function slackLinksToMarkdown(",
        ),
      ),
      ios: native(IOS_SLACK_LINKS),
      mcp: fallback(
        "the raw `<url|label>` markup, which stays readable",
        MCP_TEXT,
      ),
      acp: fallback(
        "the raw `<url|label>` markup, which stays readable",
        ACP_TEXT,
      ),
    },
  },
  {
    id: "user-mention",
    support: {
      slack: native(at(SLACK_MRKDWN, "export function wrapBareSlackUserIds(")),
      dashboard: native(at(DASHBOARD_MENTIONS, "function MentionView(")),
      ios: unsupported(
        "shows the raw `<@U…>` markup; the app rewrites only Slack links",
        IOS_SLACK_LINKS,
      ),
      mcp: unsupported(RAW_MENTION, MCP_TEXT),
      acp: unsupported(RAW_MENTION, ACP_TEXT),
    },
  },
  {
    id: "channel-mention",
    support: {
      slack: native(at(SLACK_MRKDWN, '"@", "#", "!"')),
      dashboard: fallback(
        "`#` and the label of the token, or the channel id when it has no label",
        at(DASHBOARD_MENTIONS, "function mentionLabel("),
      ),
      ios: unsupported(
        "shows the raw `<#C…>` markup; the app rewrites only Slack links",
        IOS_SLACK_LINKS,
      ),
      mcp: unsupported(RAW_MENTION, MCP_TEXT),
      acp: unsupported(RAW_MENTION, ACP_TEXT),
    },
  },
  {
    id: "emoji-code",
    support: {
      slack: native(SLACK_BLOCK),
      dashboard: native(
        at(`${DASHBOARD}/display-text/emoji.ts`, "SLACK_EMOJI_RE"),
      ),
      ios: fallback("the `:name:` code as text", IOS_SLACK_LINKS),
      mcp: fallback("the `:name:` code as text", MCP_TEXT),
      acp: fallback("the `:name:` code as text", ACP_TEXT),
    },
  },
  {
    id: "object-card",
    support: {
      slack: native(
        at(`${SLACK}/object-card.ts`, "export function renderSlackObjectCard("),
        ["card:object"],
      ),
      dashboard: native(at(DASHBOARD_MESSAGE, "<ObjectRow"), ["card:object"]),
      ios: unsupported("MCP Messages have no cards", IOS_MESSAGE),
      mcp: unsupported(
        "`mcpMessages` keeps text and attachments, not cards",
        MCP_MESSAGES,
      ),
      acp: unsupported("ACP gets only the Message text", ACP_TEXT),
    },
  },
  {
    id: "automation-card",
    support: {
      slack: native(
        at(
          `${SLACK}/automation-card.ts`,
          "export function renderSlackAutomationCard(",
        ),
        ["card:automation"],
      ),
      dashboard: native(at(DASHBOARD_MESSAGE, "<AutomationCard"), [
        "card:automation",
      ]),
      ios: unsupported("MCP Messages have no cards", IOS_MESSAGE),
      mcp: unsupported(
        "`mcpMessages` keeps text and attachments, not cards",
        MCP_MESSAGES,
      ),
      acp: unsupported("ACP gets only the Message text", ACP_TEXT),
    },
  },
  {
    id: "inbox-question",
    support: {
      slack: native(
        at(
          `${SLACK}/inbox-item-card.ts`,
          "export function buildSlackInboxItemCard(",
        ),
      ),
      dashboard: native(
        at(
          `${DASHBOARD}/shell/inbox/InboxItemCard.tsx`,
          "export function InboxItemCard(",
        ),
      ),
      ios: fallback(
        "the question, with a button that opens it on the web to answer",
        at(`${IOS_APP}/Inbox/InboxItemScreen.swift`, '"answer-on-web"'),
      ),
      mcp: fallback(
        "the title, body, and question as text, with a dashboard link to answer; no answer fields",
        at(
          "packages/junior/src/api/mcp/inbox-item.ts",
          "question: userInputQuestionText(question)",
        ),
      ),
      acp: unsupported(
        "ACP has no Inbox items and gets only the Message text",
        ACP_TEXT,
      ),
    },
  },
  {
    id: "attachment",
    support: {
      slack: native(
        at(
          `${SLACK}/outbound.ts`,
          "export async function uploadFilesToConversation(",
        ),
      ),
      dashboard: native(
        at(
          `${DASHBOARD}/conversations/TranscriptAttachmentsDeliveredView.tsx`,
          "export function TranscriptAttachmentsDeliveredView(",
        ),
      ),
      ios: unsupported(
        "files that Junior sends are `attachments_delivered` events, which MCP does not return",
        IOS_MESSAGE,
      ),
      mcp: unsupported(
        "`mcpMessages` reads only `message` events, not `attachments_delivered`",
        MCP_MESSAGES,
      ),
      acp: unsupported("ACP gets only the Message text", ACP_TEXT),
    },
  },
];
