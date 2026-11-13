/**
 * Sentry issue short ids in reply text, such as `JUNIOR-3ZK`, rendered as
 * links to the issue.
 */
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { ORG_SLUG_PATTERN } from "./urls.js";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
// Crockford base32 without the read-alike letters I, L, O, and U. At least
// one letter: an all-digit suffix is the shape of a Jira or Linear key.
const SUFFIX = "(?=[0-9]*[A-HJKMNP-TV-Z])[0-9A-HJKMNP-TV-Z]{1,13}";
// A short id must not continue a word, path, domain, or email.
const START = "(?<![\\w.\\-/@&<\\\\])";
const END = "(?![\\w-])";

/** Return the source ranges of plain text, outside code, HTML, and links. */
function textRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "text") {
      ranges.push([start, end]);
    } else if (
      node.type !== "link" &&
      node.type !== "linkReference" &&
      "children" in node
    ) {
      for (const child of node.children) visit(child);
    }
  };
  visit(
    fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  );
  return ranges;
}

/**
 * Link the short ids of the configured `project` in the `org` config value,
 * outside Markdown code and links. Without both values, return the text as is.
 */
export function linkifySentryShortIds(
  text: string,
  config: Record<string, string>,
): string {
  const org = config.org?.trim().toLowerCase() ?? "";
  const project = config.project?.trim() ?? "";
  if (!ORG_SLUG_PATTERN.test(org) || !SLUG_PATTERN.test(project)) return text;
  // Only the Location's configured `sentry.project` counts as a prefix, so a
  // Jira or Linear key with the same shape stays plain text. Matching any
  // project slug in the org is a possible follow-up. It needs core to make
  // `formatMarkdown` async, so the hook can read the org's project list.
  const prefix = project.toUpperCase();
  const pattern = new RegExp(`${START}${prefix}-${SUFFIX}${END}`, "g");
  let result = "";
  let cursor = 0;
  for (const [start, end] of textRanges(text)) {
    result += text.slice(cursor, start);
    result += text
      .slice(start, end)
      .replace(
        pattern,
        (shortId) =>
          `[${shortId}](https://${org}.sentry.io/issues/${shortId}/)`,
      );
    cursor = end;
  }
  return result + text.slice(cursor);
}
