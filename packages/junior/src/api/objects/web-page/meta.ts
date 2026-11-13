/**
 * Read Open Graph and Twitter card meta tags from the start of an HTML page.
 * Junior reads only these tags and the `<title>`, never scripts or markup.
 */

/** What the meta tags of one page say about it. */
export interface PageMeta {
  author?: string;
  description?: string;
  image?: string;
  siteName?: string;
  title?: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    },
  );
}

function clean(text: string | undefined): string | undefined {
  const value = text && decodeEntities(text).replace(/\s+/g, " ").trim();
  return value || undefined;
}

function attributes(tag: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of tag.matchAll(
    /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
  )) {
    values.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return values;
}

/** Read the Open Graph and Twitter card tags, then the `<title>`. */
export function parsePageMeta(html: string): PageMeta {
  // The tags are in `<head>`. Do not read meta tags in the page body.
  const head = html.split(/<body[\s>]/i, 1)[0] ?? html;
  const tags = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\s[^>]*>/gi)) {
    const values = attributes(tag);
    const name = (values.get("property") ?? values.get("name"))?.toLowerCase();
    const content = values.get("content");
    // The first tag of a name wins, as in Open Graph readers.
    if (name && content !== undefined && !tags.has(name)) {
      tags.set(name, content);
    }
  }
  const first = (...names: string[]) =>
    names.map((name) => clean(tags.get(name))).find(Boolean);
  const title =
    first("og:title", "twitter:title") ??
    clean(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  return {
    author: first("author", "twitter:creator"),
    description: first("og:description", "twitter:description", "description"),
    image: first(
      "og:image:secure_url",
      "og:image",
      "og:image:url",
      "twitter:image",
      "twitter:image:src",
    ),
    siteName: first("og:site_name", "application-name"),
    title,
  };
}
