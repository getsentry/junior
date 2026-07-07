import { escapeXml } from "@/chat/xml";

const CURRENT_INSTRUCTION_TAG = "current-instruction";
const CURRENT_INSTRUCTION_OPEN_PREFIX = `<${CURRENT_INSTRUCTION_TAG}`;
const CURRENT_INSTRUCTION_OPEN_BARE = `<${CURRENT_INSTRUCTION_TAG}>`;
const CURRENT_INSTRUCTION_OPEN_ATTR_PREFIX = `<${CURRENT_INSTRUCTION_TAG} `;
const CURRENT_INSTRUCTION_CLOSE = `\n</${CURRENT_INSTRUCTION_TAG}>`;

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function isCurrentInstructionOpeningTag(value: string): boolean {
  return (
    value === CURRENT_INSTRUCTION_OPEN_BARE ||
    (value.startsWith(CURRENT_INSTRUCTION_OPEN_ATTR_PREFIX) &&
      value.endsWith(">"))
  );
}

function readCurrentInstructionBody(text: string): string | undefined {
  const start = text.indexOf(CURRENT_INSTRUCTION_OPEN_PREFIX);
  if (start < 0) {
    return undefined;
  }
  const openingEnd = text.indexOf(">\n", start);
  if (openingEnd < 0) {
    return undefined;
  }
  const openingTag = text.slice(start, openingEnd + 1);
  if (!isCurrentInstructionOpeningTag(openingTag)) {
    return undefined;
  }
  const bodyStart = openingEnd + 2;
  const bodyEnd = text.indexOf(CURRENT_INSTRUCTION_CLOSE, bodyStart);
  if (bodyEnd < bodyStart) {
    return undefined;
  }
  return text.slice(bodyStart, bodyEnd);
}

/** Render the active user task in a stable prompt boundary. */
export function renderCurrentInstruction(
  instruction: string,
  attrs?: {
    authorId?: string;
    authorName?: string;
    slackTs?: string;
  },
): string {
  const renderedAttrs = [
    attrs?.authorId ? `author_id="${escapeXml(attrs.authorId)}"` : undefined,
    attrs?.authorName
      ? `author_name="${escapeXml(attrs.authorName)}"`
      : undefined,
    attrs?.slackTs ? `slack_ts="${escapeXml(attrs.slackTs)}"` : undefined,
  ]
    .filter((attr): attr is string => Boolean(attr))
    .join(" ");
  const openingTag = renderedAttrs
    ? `<${CURRENT_INSTRUCTION_TAG} ${renderedAttrs}>`
    : `<${CURRENT_INSTRUCTION_TAG}>`;
  return [
    openingTag,
    escapeXml(instruction),
    `</${CURRENT_INSTRUCTION_TAG}>`,
  ].join("\n");
}

/** Recover display text from the internal current-task prompt boundary. */
export function unwrapCurrentInstruction(text: string): string | undefined {
  const body = readCurrentInstructionBody(text);
  return body === undefined ? undefined : unescapeXml(body);
}
