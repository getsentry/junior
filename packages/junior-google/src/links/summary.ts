import {
  type ObjectLinkContext,
  objectSummary,
} from "@sentry/junior-plugin-api";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import * as z from "zod";
import { type FileReference, resourceKeyHeaders } from "../tools/files";
import { googleApiRequest } from "../tools/shared";

type Node = DefaultTreeAdapterMap["node"];

// Elements that end a line of text. Their text must not join the next word.
const BREAKS = new Set(["br", "div", "li", "p", "tr", "h1", "h2", "h3"]);
const HIDDEN = new Set(["script", "style", "template"]);

/**
 * Make a card summary from a Calendar event description. Calendar stores
 * descriptions as HTML or plain text, so parse it and keep only the text.
 */
export function htmlSummary(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeName === "#text" && "value" in node) parts.push(node.value);
    if (HIDDEN.has(node.nodeName)) return;
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if (BREAKS.has(node.nodeName)) parts.push(" ");
  };
  visit(parseFragment(html));
  return objectSummary(parts.join(""));
}

const paragraphsSchema = z.object({
  body: z
    .object({
      content: z
        .array(
          z.object({
            paragraph: z
              .object({
                elements: z
                  .array(
                    z.object({
                      textRun: z.object({ content: z.string() }).optional(),
                    }),
                  )
                  .default([]),
                paragraphStyle: z
                  .object({ namedStyleType: z.string().optional() })
                  .optional(),
              })
              .optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

// The title and headings name the Doc. The first body paragraph says what it
// is about.
const BODY_STYLES = new Set([undefined, "NORMAL_TEXT"]);

/**
 * Read the first body paragraph of a Doc as a card summary. Call it only
 * after the viewer may open the Doc. A Docs API failure gives no summary,
 * so the card still shows.
 */
export async function docSummary(
  ctx: ObjectLinkContext,
  file: FileReference,
): Promise<string | undefined> {
  const response = await googleApiRequest(ctx, {
    headers: resourceKeyHeaders(file),
    operation: "google.docs.document.get",
    path: `/v1/documents/${file.fileId}`,
    query: {
      fields:
        "body.content(paragraph(elements(textRun(content)),paragraphStyle(namedStyleType)))",
    },
  }).catch((error: unknown) => {
    ctx.log.warn("Google Doc summary read failed", { error: String(error) });
    return undefined;
  });
  if (response?.status !== 200) return undefined;
  const parsed = paragraphsSchema.safeParse(response.body);
  for (const { paragraph } of parsed.data?.body?.content ?? []) {
    if (!paragraph) continue;
    if (!BODY_STYLES.has(paragraph.paragraphStyle?.namedStyleType)) continue;
    const text = objectSummary(
      paragraph.elements
        .map((element) => element.textRun?.content ?? "")
        .join(""),
    );
    if (text) return text;
  }
  return undefined;
}
