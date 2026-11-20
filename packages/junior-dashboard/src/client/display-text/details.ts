/**
 * Agent replies wrap supporting detail in `<details>` with a `<summary>`
 * title, the same markup Slack shows as a collapsed container
 * (`packages/junior/src/chat/slack/details.ts`). Markdown keeps that markup as
 * raw HTML, which the transcript shows as text. This plugin turns each closed
 * section into `details` and `summary` elements around the Markdown between
 * the tags. A section without its closing tag stays as it is.
 */

type MarkdownNode = {
  children?: MarkdownNode[] | undefined;
  data?: { hName?: string };
  type: string;
  value?: string;
};

const OPEN_RE =
  /^<details(?:\s[^>]*)?>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i;
const SUMMARY_RE = /^<summary>([\s\S]*?)<\/summary>\s*$/i;
const CLOSE_RE = /^<\/details>\s*$/i;

function html(node: MarkdownNode | undefined, re: RegExp) {
  return node?.type === "html" ? node.value?.trim().match(re) : null;
}

function summaryNode(text: string | undefined): MarkdownNode {
  const label = (text ?? "").replace(/[*_~`]/g, "").trim() || "Details";
  return {
    children: [{ type: "text", value: label }],
    data: { hName: "summary" },
    type: "detailsSummary",
  };
}

/**
 * Put blank lines around the `<details>` tags. An HTML block runs until a
 * blank line, so without one the Markdown after `</summary>` stays raw HTML.
 */
export function spaceDetailsTags(text: string): string {
  return text
    .replace(
      /^([ \t]*<\/summary>|[ \t]*<summary>.*<\/summary>)[ \t]*$/gim,
      "$1\n",
    )
    .replace(/^[ \t]*<\/details>[ \t]*$/gim, "\n</details>\n");
}

/** Turn top-level `<details>` sections into disclosure elements. */
export function remarkDetails() {
  return (tree: MarkdownNode) => {
    const children = tree.children ?? [];
    const result: MarkdownNode[] = [];
    for (let i = 0; i < children.length; i++) {
      const open = html(children[i], OPEN_RE);
      const end = open
        ? children.findIndex((node, j) => j > i && html(node, CLOSE_RE))
        : -1;
      if (!open || end === -1) {
        result.push(children[i]!);
        continue;
      }
      let body = children.slice(i + 1, end);
      let summary = open[1];
      const separate = summary === undefined ? html(body[0], SUMMARY_RE) : null;
      if (separate) {
        summary = separate[1];
        body = body.slice(1);
      }
      result.push({
        children: [summaryNode(summary), ...body],
        data: { hName: "details" },
        type: "details",
      });
      i = end;
    }
    tree.children = result;
  };
}
