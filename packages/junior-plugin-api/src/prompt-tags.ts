/**
 * The one writer, escape, and reader for tags in model-read text. Core and
 * plugins build every prompt tag here, so all tags fence untrusted text the
 * same way, and code reads stored history back with the same rules. Lint
 * rules ban tag literals, tag regexes, and entity escapes elsewhere.
 * `policies/prompt-markers.md` in getsentry/junior owns the tag rules.
 */

/** Attribute values of one tag. An undefined or empty value is left out. */
export type PromptTagAttributes = Record<string, string | number | undefined>;

/**
 * Escape text that a person, an agent, a model, or a provider wrote, for a
 * tag body. Escaping `<` also keeps it from imitating one of our tags.
 * Quotes stay as written.
 */
export function escapeTagText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Escape free text, such as a name or a title, for an attribute value. */
function escapeTagAttribute(value: string): string {
  return escapeTagText(value).replaceAll('"', "&quot;");
}

/**
 * Escape text and both quote characters. Older tag kinds, such as
 * `<current-instruction>` and `<thread-context>`, still render this way, so
 * their bytes stay the same for the prompt cache. Each kind moves to
 * `escapeTagText` when it drops its attributes.
 */
export function escapeTagTextAndQuotes(value: string): string {
  return escapeTagAttribute(value).replaceAll("'", "&apos;");
}

/** Read back text escaped by any escape in this module. */
export function unescapeTagText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/**
 * Escape each closing-tag start (`</`) in text that the runtime writes into a
 * job tag. Other markup, such as a Slack mention `<@U123>`, stays as written
 * so the model can copy it.
 */
export function escapeClosingTags(value: string): string {
  return value.replaceAll("</", "&lt;/");
}

/** Read back text escaped by `escapeClosingTags`. */
export function unescapeClosingTags(value: string): string {
  return value.replaceAll("&lt;/", "</");
}

/**
 * Escape copies of one closing tag in raw text, such as `AGENTS.md` or tool
 * declarations, so the text cannot end the tag around it.
 */
export function escapeClosingTag(value: string, name: string): string {
  return value.replaceAll(`</${name}>`, `&lt;/${name}>`);
}

/** Read back text escaped by `escapeClosingTag`. */
export function unescapeClosingTag(value: string, name: string): string {
  return value.replaceAll(`&lt;/${name}>`, `</${name}>`);
}

/**
 * Encode values that the model passes to tools unchanged. The JSON stays
 * valid with the same values, and it cannot close the tag around it.
 */
export function tagJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function openingTag(
  name: string,
  attributes: PromptTagAttributes,
  escapeAttribute: (value: string) => string,
): string {
  const rendered = Object.entries(attributes).flatMap(([key, value]) =>
    value === undefined || value === ""
      ? []
      : [`${key}="${escapeAttribute(String(value))}"`],
  );
  return rendered.length ? `<${name} ${rendered.join(" ")}>` : `<${name}>`;
}

/**
 * Render one tag with the opening and closing tags on their own lines.
 * Attribute values are escaped. Body lines are joined as given, so the
 * caller escapes untrusted text. Only tag kinds in
 * `tools/oxlint/junior/prompt-tag-attributes.json` may pass attributes.
 */
export function renderTag(
  name: string,
  attributes: PromptTagAttributes,
  body: readonly string[],
  escapeAttribute: (value: string) => string = escapeTagAttribute,
): string {
  return [
    openingTag(name, attributes, escapeAttribute),
    ...body,
    `</${name}>`,
  ].join("\n");
}

/** Render one short tag on one line, such as `<summary>`, around escaped text. */
export function renderInlineTag(
  name: string,
  text: string,
  attributes: PromptTagAttributes = {},
): string {
  return `${openingTag(name, attributes, escapeTagAttribute)}${text}</${name}>`;
}

/** Render one tag with no body, such as a truncation marker. */
export function renderEmptyTag(
  name: string,
  attributes: PromptTagAttributes,
): string {
  return `${openingTag(name, attributes, escapeTagAttribute).slice(0, -1)} />`;
}

/**
 * Indent only the opening and closing lines of a rendered tag, for a child
 * tag in a list whose body text keeps its bytes.
 */
export function indentTagLines(block: string, prefix: string): string {
  const lines = block.split("\n");
  const last = lines.length - 1;
  return lines
    .map((line, index) =>
      index === 0 || index === last ? `${prefix}${line}` : line,
    )
    .join("\n");
}

/** One tag that `findTag` found, with offsets into the text. */
export interface PromptTagBlock {
  /** Raw body between the opening and closing tags. */
  body: string;
  /** Offset just after the closing tag. */
  end: number;
  /** The opening tag, with its raw attributes. */
  opening: string;
  /** Offset of the opening tag. */
  start: number;
}

function isLineStart(text: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char === "\n") return true;
    if (char !== " " && char !== "\t") return false;
  }
  return true;
}

// Offset of the next opening tag of `name` that starts a line, or -1. A
// line may be indented. Text that only mentions the tag mid-line is not a
// tag: escaped text cannot hold `<`, so only raw text can mention it.
function openingTagIndex(text: string, name: string, from: number): number {
  const prefix = `<${name}`;
  for (
    let index = text.indexOf(prefix, from);
    index >= 0;
    index = text.indexOf(prefix, index + 1)
  ) {
    const next = text[index + prefix.length];
    if (
      (next === ">" || next === " " || next === "\n") &&
      isLineStart(text, index)
    ) {
      return index;
    }
  }
  return -1;
}

function blockAt(
  text: string,
  start: number,
  closeIndex: number,
  name: string,
): PromptTagBlock {
  const openingEnd = text.indexOf(">", start) + 1;
  let bodyStart = openingEnd;
  let bodyEnd = closeIndex;
  if (text[bodyStart] === "\n") bodyStart += 1;
  if (bodyEnd > bodyStart && text[bodyEnd - 1] === "\n") bodyEnd -= 1;
  return {
    body: text.slice(bodyStart, bodyEnd),
    end: closeIndex + `</${name}>`.length,
    opening: text.slice(start, openingEnd),
    start,
  };
}

/**
 * Find the first tag of `name` whose opening tag starts a line, at or after
 * `from`. Its body ends at the next closing tag. Escaped bodies cannot hold
 * a copy of the closing tag, so that is the real end.
 */
export function findTag(
  text: string,
  name: string,
  from = 0,
): PromptTagBlock | undefined {
  const start = openingTagIndex(text, name, from);
  if (start < 0) return undefined;
  const openingEnd = text.indexOf(">", start);
  if (openingEnd < 0) return undefined;
  const closeIndex = text.indexOf(`</${name}>`, openingEnd + 1);
  if (closeIndex < 0) return undefined;
  return blockAt(text, start, closeIndex, name);
}

/** Find every tag of `name`, in order. */
export function findTags(text: string, name: string): PromptTagBlock[] {
  const blocks: PromptTagBlock[] = [];
  for (
    let block = findTag(text, name);
    block;
    block = findTag(text, name, block.end)
  ) {
    blocks.push(block);
  }
  return blocks;
}

/**
 * Return the raw body when the whole text is one tag of `name`, or
 * undefined. A prompt part that holds one runtime input has this shape.
 */
export function readTag(text: string, name: string): string | undefined {
  if (!startsWithTag(text, [name])) return undefined;
  const closing = `</${name}>`;
  if (!text.endsWith(closing)) return undefined;
  return blockAt(text, 0, text.length - closing.length, name).body;
}

/** Return whether the text starts with an opening tag of one of `names`. */
export function startsWithTag(text: string, names: readonly string[]): boolean {
  return names.some(
    (name) => text.startsWith(`<${name}>`) || text.startsWith(`<${name} `),
  );
}

/**
 * Return whether the text holds an opening or closing tag of one of
 * `names` anywhere, even mid-line. Use it to keep runtime markers out of
 * text that the runtime stores, not to read a tag.
 */
export function mentionsTag(text: string, names: readonly string[]): boolean {
  return names.some((name) =>
    [`<${name}`, `</${name}`].some((prefix) => {
      for (
        let index = text.indexOf(prefix);
        index >= 0;
        index = text.indexOf(prefix, index + 1)
      ) {
        const next = text[index + prefix.length];
        if (next === undefined || !/[\w-]/.test(next)) return true;
      }
      return false;
    }),
  );
}

/**
 * Remove each tag of `names` and the line breaks before it. The body runs to
 * the last closing tag of that name: older history has unescaped bodies, and
 * a copy of the closing tag in one of them must not end the block early.
 */
export function stripTags(text: string, names: readonly string[]): string {
  let result = text;
  for (const name of names) {
    for (
      let start = openingTagIndex(result, name, 0);
      start >= 0;
      start = openingTagIndex(result, name, start)
    ) {
      const closing = `</${name}>`;
      const closeIndex = result.lastIndexOf(closing);
      if (closeIndex < start) break;
      let cut = start;
      while (cut > 0 && result[cut - 1] === "\n") cut -= 1;
      result = result.slice(0, cut) + result.slice(closeIndex + closing.length);
      start = cut;
    }
  }
  return result;
}
