/**
 * Collapsed sections in Slack replies.
 *
 * An agent reply can wrap supporting detail in an HTML `<details>` element
 * with a `<summary>` title, as GitHub Markdown does. Slack shows the section
 * as a collapsed `container` block: the reader sees the title and expands it
 * to read the rest. The dashboard renders the same markup as a disclosure.
 */
import type { AnyBlock, KnownBlock } from "@slack/types";
import { SlackFormatConverter } from "@chat-adapter/slack";
import { markdownPlainText } from "@sentry/junior-plugin-api";

// Slack limits: a container holds 10 child blocks and a 150-character title.
// A section holds 3,000 characters of text.
const MAX_CHILD_BLOCKS = 10;
const MAX_TITLE_CHARS = 150;
const MAX_SECTION_CHARS = 3000;

// `<details>` and `<summary>` are HTML markup in reply text, not prompt tags.
/* oxlint-disable junior/no-prompt-tag-matching */
const DETAILS_OPEN_RE =
  /^<details(?:\s[^>]*)?>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i;
const SUMMARY_RE = /^<summary>(.*?)<\/summary>\s*$/i;
const DETAILS_CLOSE_RE = /^<\/details>\s*$/i;
/* oxlint-enable junior/no-prompt-tag-matching */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

type ReplySegment =
  | { kind: "markdown"; text: string }
  | { body: string; kind: "details"; summary: string };

/**
 * Slack's `container` block. `@slack/types` 2.x predates it, so this repo
 * declares the fields it sends and posts it as a generic `Block`.
 */
type SlackContainerBlock = {
  child_blocks: KnownBlock[];
  default_collapsed: boolean;
  is_collapsible: boolean;
  title: { text: string; type: "plain_text" };
  type: "container";
};

// Track code fences line by line. `inFence` is true for the fence lines
// and every line between them, so markup there stays text.
function stepFence(
  line: string,
  fence: string | undefined,
): { fence: string | undefined; inFence: boolean } {
  const marker = line.match(FENCE_RE)?.[1];
  const inFence = fence !== undefined || marker !== undefined;
  if (marker && !fence) return { fence: marker, inFence };
  if (marker && fence && marker.startsWith(fence)) {
    return { fence: undefined, inFence };
  }
  return { fence, inFence };
}

function plainSummary(summary: string | undefined): string {
  const text = markdownPlainText(summary ?? "");
  return (text || "Details").slice(0, MAX_TITLE_CHARS);
}

/**
 * Split reply markdown into plain parts and closed `<details>` sections.
 * Markup inside a code fence stays text. A `<details>` element without its
 * closing tag, such as one that a long reply split across posts, stays text
 * too, so `detailsToMarkdown` can show it inline.
 */
function splitReplySegments(text: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  const lines = text.split("\n");
  let plain: string[] = [];
  let fence: string | undefined;
  let open: { body: string[]; start: number; summary?: string } | undefined;

  const flushPlain = () => {
    const joined = plain.join("\n").trim();
    if (joined) segments.push({ kind: "markdown", text: joined });
    plain = [];
  };

  for (const [index, line] of lines.entries()) {
    const step = stepFence(line, fence);
    fence = step.fence;
    const inFence = step.inFence;
    const trimmed = line.trim();

    if (open) {
      if (!inFence && DETAILS_CLOSE_RE.test(trimmed)) {
        flushPlain();
        segments.push({
          body: open.body.join("\n").trim(),
          kind: "details",
          summary: plainSummary(open.summary),
        });
        open = undefined;
        continue;
      }
      const summary = trimmed.match(SUMMARY_RE);
      if (!inFence && summary && open.summary === undefined) {
        open.summary = summary[1] ?? "";
        continue;
      }
      open.body.push(line);
      continue;
    }

    const opener = inFence ? undefined : trimmed.match(DETAILS_OPEN_RE);
    if (opener) {
      open = {
        body: [],
        start: index,
        ...(opener[1] !== undefined ? { summary: opener[1] } : undefined),
      };
      continue;
    }
    plain.push(line);
  }

  if (open) {
    // No closing tag: keep the original lines as plain text.
    plain.push(...lines.slice(open.start));
  }
  flushPlain();
  return segments;
}

/**
 * Rewrite `<details>` markup as plain Markdown: the summary becomes a bold
 * label above its body. Use it where Slack shows text without blocks, such
 * as notifications, and for a section that cannot fit a container. Markup
 * inside a code fence stays text. Text that is only markup, such as a lone
 * closing tag that a long reply split into its own post, stays as written,
 * because Slack rejects a post with empty text.
 */
export function detailsToMarkdown(text: string): string {
  let fence: string | undefined;
  const markdown = text
    .split("\n")
    .flatMap((line) => {
      const step = stepFence(line, fence);
      fence = step.fence;
      if (step.inFence) return [line];
      const trimmed = line.trim();
      const opener = trimmed.match(DETAILS_OPEN_RE);
      if (opener) {
        return opener[1] !== undefined
          ? [`**${plainSummary(opener[1])}**`]
          : [];
      }
      const summary = trimmed.match(SUMMARY_RE);
      if (summary) return [`**${plainSummary(summary[1])}**`];
      if (DETAILS_CLOSE_RE.test(trimmed)) return [];
      return [line];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown || text.trim();
}

// Section blocks read Slack mrkdwn, not Markdown. The converter parses
// Markdown, so turn Slack `<url|label>` links into Markdown links first.
function toSlackMrkdwn(markdown: string): string {
  const withMarkdownLinks = markdown.replace(
    /<(https?:\/\/[^|>\s]+)\|([^>]+)>/g,
    (_, url: string, label: string) =>
      `[${label.replace(/([\\[\]])/g, "\\$1")}](${url})`,
  );
  return new SlackFormatConverter()
    .toResponseUrlText({ markdown: withMarkdownLinks })
    .trim();
}

// Split at a line break so a section never cuts a line in two. A line too
// long for one section returns undefined, so the caller shows the whole
// body inline instead of dropping part of it.
function splitSections(text: string): string[] | undefined {
  const sections: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > MAX_SECTION_CHARS) return undefined;
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= MAX_SECTION_CHARS) {
      current = next;
      continue;
    }
    if (current) sections.push(current);
    current = line;
  }
  if (current.trim()) sections.push(current);
  return sections;
}

function containerBlock(
  summary: string,
  body: string,
): SlackContainerBlock | undefined {
  const sections = splitSections(toSlackMrkdwn(body));
  if (
    !sections ||
    sections.length === 0 ||
    sections.length > MAX_CHILD_BLOCKS
  ) {
    return undefined;
  }
  return {
    type: "container",
    title: { type: "plain_text", text: summary },
    is_collapsible: true,
    default_collapsed: true,
    child_blocks: sections.map((text) => ({
      type: "section",
      text: { type: "mrkdwn", text },
    })),
  };
}

/**
 * Build the body blocks of one reply post. Plain parts use the `markdown`
 * block. Each closed `<details>` section becomes a collapsed container. A
 * section too large for a container shows inline with a bold label.
 */
export function buildReplyBodyBlocks(text: string): AnyBlock[] {
  const blocks: AnyBlock[] = [];
  let markdown: string[] = [];
  const flushMarkdown = () => {
    if (markdown.length) {
      blocks.push({ type: "markdown", text: markdown.join("\n\n") });
    }
    markdown = [];
  };

  for (const segment of splitReplySegments(text)) {
    if (segment.kind === "markdown") {
      markdown.push(detailsToMarkdown(segment.text));
      continue;
    }
    const container = segment.body
      ? containerBlock(segment.summary, segment.body)
      : undefined;
    if (container) {
      flushMarkdown();
      blocks.push(container);
    } else if (segment.body) {
      markdown.push(`**${segment.summary}**\n\n${segment.body}`);
    }
  }
  flushMarkdown();
  return blocks;
}
