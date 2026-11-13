/**
 * Read Open Graph and Twitter card meta tags from the `<head>` of an HTML
 * page. Junior reads only these tags and the `<title>`, never scripts or
 * other markup.
 */
import { type DefaultTreeAdapterMap, parse } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** What the meta tags of one page say about it. */
export interface PageMeta {
  author?: string;
  description?: string;
  /** Image candidates, best first. A page can list one Junior cannot use. */
  images: string[];
  siteName?: string;
  title?: string;
}

function isElement(node: Node, tagName: string): node is Element {
  return "tagName" in node && node.tagName === tagName;
}

function children(node: Node): Node[] {
  return "childNodes" in node ? node.childNodes : [];
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function text(node: Node): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  return children(node).map(text).join("");
}

function clean(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

/** Read the Open Graph and Twitter card tags, then the `<title>`. */
export function parsePageMeta(html: string): PageMeta {
  // parse5 decodes entities and puts each tag where a browser would, so
  // meta tags in the page body are not read.
  const root = children(parse(html)).find((node) => isElement(node, "html"));
  const head = root && children(root).find((node) => isElement(node, "head"));
  const tags = new Map<string, string>();
  let title: string | undefined;
  for (const node of head ? children(head) : []) {
    if (isElement(node, "title")) title ??= clean(text(node));
    if (!isElement(node, "meta")) continue;
    const name = (
      attribute(node, "property") ?? attribute(node, "name")
    )?.toLowerCase();
    const content = clean(attribute(node, "content"));
    // The first tag of a name wins, as in Open Graph readers.
    if (name && content && !tags.has(name)) tags.set(name, content);
  }
  const first = (...names: string[]) =>
    names.map((name) => tags.get(name)).find(Boolean);
  return {
    author: first("author", "twitter:creator"),
    description: first("og:description", "twitter:description", "description"),
    images: [
      "og:image:secure_url",
      "og:image",
      "og:image:url",
      "twitter:image",
      "twitter:image:src",
    ].flatMap((name) => tags.get(name) ?? []),
    siteName: first("og:site_name", "application-name"),
    title: first("og:title", "twitter:title") ?? title,
  };
}
