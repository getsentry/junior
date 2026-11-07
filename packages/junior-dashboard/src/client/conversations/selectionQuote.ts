// A double-click selects one word. A slipped click or drag selects a few
// characters or a mark. Neither is text to ask about or quote.
const MIN_SELECTION_WORDS = 2;
const MIN_SELECTION_CHARS = 6;
// Finds words also in scripts that do not put spaces between words.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** True when selected text is long enough to be a deliberate quote. */
export function isDeliberateSelection(text: string): boolean {
  if (text.length < MIN_SELECTION_CHARS) return false;
  let words = 0;
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike) words += 1;
    if (words >= MIN_SELECTION_WORDS) return true;
  }
  return false;
}

/** Format text as a Markdown blockquote. */
export function markdownQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
}

// A selection inside one of these elements clones only its contents. Put the
// element back around them, so a bold word stays bold and list items keep
// their list.
const CONTEXT_TAGS = new Set([
  "A",
  "B",
  "CODE",
  "DEL",
  "EM",
  "I",
  "OL",
  "S",
  "STRONG",
  "TABLE",
  "TBODY",
  "THEAD",
  "TR",
  "UL",
]);

/**
 * Rebuild Markdown for a selection in rendered display text. The page shows
 * HTML, so `Selection.toString()` loses marks, links, lists, and code.
 */
export function selectionMarkdown(range: Range): string {
  const start = range.commonAncestorContainer;
  let element = start instanceof Element ? start : start.parentElement;
  const pre = element?.closest("pre");
  if (pre) return fence(pre, range.toString());
  let node: Node = range.cloneContents();
  while (element && CONTEXT_TAGS.has(element.tagName)) {
    const shell = element.cloneNode(false);
    shell.appendChild(node);
    node = shell;
    element = element.parentElement;
  }
  return render(node)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function render(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return renderText(node);
  if (!(node instanceof Element)) return renderChildren(node);
  if (node.matches("button, svg, [aria-hidden='true']")) return "";
  const tag = node.tagName;
  switch (tag) {
    case "BR":
      return "\n";
    case "B":
    case "STRONG":
      return mark("**", renderChildren(node));
    case "EM":
    case "I":
      return mark("_", renderChildren(node));
    case "DEL":
    case "S":
      return mark("~~", renderChildren(node));
    case "CODE":
      return mark("`", node.textContent ?? "");
    case "A": {
      const text = renderChildren(node);
      const href = node.getAttribute("href") ?? "";
      // People links point into the dashboard. Keep only their label.
      return /^https?:/i.test(href) && text.trim() !== href
        ? `[${text}](${href})`
        : text;
    }
    case "INPUT":
      return node.getAttribute("type") === "checkbox"
        ? node.hasAttribute("checked")
          ? "[x] "
          : "[ ] "
        : "";
    case "PRE":
      return block(fence(node, node.textContent ?? ""));
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return block(`${"#".repeat(Number(tag[1]))} ${renderChildren(node)}`);
    case "BLOCKQUOTE":
      return block(markdownQuote(renderChildren(node).trim()));
    case "OL":
    case "UL":
      return block(renderList(node));
    case "TABLE":
      return block(renderTable(node));
    case "HR":
      return block("---");
    case "DIV":
    case "LI":
    case "P":
      return block(renderChildren(node));
    default:
      return renderChildren(node);
  }
}

function renderChildren(node: Node): string {
  return Array.from(node.childNodes, render).join("");
}

// Source newlines in prose render as spaces. A `<br>` is the line break.
function renderText(node: Node): string {
  const raw = node.textContent ?? "";
  // The renderer puts a newline between blocks. Blocks add their own breaks.
  if (!raw.trim() && raw.includes("\n")) return "";
  let text = raw.replace(/\s+/g, " ");
  if (node.previousSibling?.nodeName === "BR") text = text.trimStart();
  if (node.nextSibling?.nodeName === "BR") text = text.trimEnd();
  return text;
}

function block(text: string): string {
  return `\n\n${text.trim()}\n\n`;
}

// Keep spaces outside the marks: `** bold**` is not bold in Markdown.
function mark(marker: string, text: string): string {
  const [, before = "", core = "", after = ""] =
    /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
  return core ? `${before}${marker}${core}${marker}${after}` : text;
}

function fence(pre: Element, code: string): string {
  const language =
    pre.closest<HTMLElement>("[data-code-language]")?.dataset.codeLanguage ??
    "";
  return `\`\`\`${language}\n${code.replace(/\n$/, "")}\n\`\`\``;
}

function renderList(list: Element): string {
  let number = Number(list.getAttribute("start") ?? 1);
  return Array.from(list.children)
    .filter((item) => item.tagName === "LI")
    .map((item) => {
      const marker = list.tagName === "OL" ? `${number++}. ` : "- ";
      const body = renderChildren(item)
        .trim()
        .replace(/\n{2,}/g, "\n");
      return marker + body.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
    })
    .join("\n");
}

function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr"), (row) =>
    Array.from(row.children, (cell) =>
      renderChildren(cell)
        .trim()
        .replace(/\s*\n\s*/g, " ")
        // `\|` keeps a pipe in its cell. Double the backslashes before it,
        // or `\\|` escapes the backslash and the pipe splits the cell.
        .replace(/(\\*)\|/g, "$1$1\\|"),
    ),
  );
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (!width) return "";
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  // The renderer marks column alignment with a class on each header cell.
  const headerCells = Array.from(table.querySelector("tr")?.children ?? []);
  const align = Array.from({ length: width }, (_, index) => {
    const cell = headerCells[index];
    if (cell?.classList.contains("text-center")) return ":---:";
    return cell?.classList.contains("text-right") ? "---:" : "---";
  });
  const [header = [], ...body] = rows;
  return [line(header), line(align), ...body.map(line)].join("\n");
}
